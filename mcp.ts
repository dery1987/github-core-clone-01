// mcp.ts — Model Context Protocol endpoint (JSON-RPC 2.0) for the
// GitHub-compatible forge.
//
// Node stdlib only (node:http). No dependencies. Implements the MCP
// methods used by MCP clients (e.g. github-mcp-server clients):
//   initialize, notifications/initialized, tools/list, tools/call, ping
// Batch requests are not supported (one request per call).
//
// Tool names follow github-mcp-server where possible, plus short
// aliases (list_repos, get_repo). tools/call returns
//   { content: [{ type: "text", text: JSON.stringify(result) }],
//     structuredContent: result }
// Unknown tool -> JSON-RPC -32601; missing required argument ->
// -32602; referenced repo/issue/PR not found -> -32004 (server error).
// MCP JSON payloads use REST-shaped objects (lowercase state
// "open"/"closed") from graphql.ts, so records created via REST,
// GraphQL, or MCP are interchangeable (see graphql.ts header).
//
// This module owns no server: the coordinator wires `mcpHandler`
// into app.ts for POST /mcp (and GET /mcp for info). Pure
// `handleMcpRequest(payload)` is exported for tests.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CREATED_AT,
  createIssueRecord,
  createPullRequestRecord,
  findRepo,
  issueNumber,
  issueToJson,
  listIssuesForRepo,
  listPRsForRepo,
  prNumber,
  prToJson,
  readJsonBody,
  repoToJson,
  sendJson,
  stateLower,
} from "./graphql.ts";
import { store } from "./store.ts";

export const MCP_SERVER_NAME = "github-forge";
export const MCP_SERVER_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------
// Tool definitions (tools/list payload)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDef["inputSchema"] {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const int = (description: string): Record<string, unknown> => ({ type: "integer", description });

export const MCP_TOOLS: ToolDef[] = [
  {
    name: "list_repositories",
    description: "List repositories in the forge.",
    inputSchema: schema({ limit: int("Maximum number of repositories to return (default 30).") }),
  },
  {
    name: "list_repos",
    description: "Alias of list_repositories: list repositories in the forge.",
    inputSchema: schema({ limit: int("Maximum number of repositories to return (default 30).") }),
  },
  {
    name: "get_repository",
    description: "Get a repository by owner and name.",
    inputSchema: schema(
      { owner: str("Repository owner login."), repo: str("Repository name.") },
      ["owner", "repo"],
    ),
  },
  {
    name: "get_repo",
    description: "Alias of get_repository: get a repository by owner and name.",
    inputSchema: schema(
      { owner: str("Repository owner login."), repo: str("Repository name.") },
      ["owner", "repo"],
    ),
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: schema(
      {
        limit: int("Maximum number of issues to return (default 30)."),
        owner: str("Repository owner login."),
        repo: str("Repository name."),
        state: str('Issue state filter: "open", "closed", or "all" (default "open").'),
      },
      ["owner", "repo"],
    ),
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: schema(
      {
        body: str("Issue body (optional)."),
        owner: str("Repository owner login."),
        repo: str("Repository name."),
        title: str("Issue title."),
      },
      ["owner", "repo", "title"],
    ),
  },
  {
    name: "get_issue",
    description: "Get an issue by number.",
    inputSchema: schema(
      {
        issue_number: int("Issue number."),
        owner: str("Repository owner login."),
        repo: str("Repository name."),
      },
      ["owner", "repo", "issue_number"],
    ),
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository.",
    inputSchema: schema(
      {
        limit: int("Maximum number of pull requests to return (default 30)."),
        owner: str("Repository owner login."),
        repo: str("Repository name."),
        state: str('Pull request state filter: "open", "closed", or "all" (default "open").'),
      },
      ["owner", "repo"],
    ),
  },
  {
    name: "create_pull_request",
    description: "Create a pull request in a repository.",
    inputSchema: schema(
      {
        base: str("Base branch name (e.g. \"main\")."),
        body: str("Pull request body (optional)."),
        head: str("Head branch name (e.g. \"feature\")."),
        owner: str("Repository owner login."),
        repo: str("Repository name."),
        title: str("Pull request title."),
      },
      ["owner", "repo", "title", "head", "base"],
    ),
  },
  {
    name: "get_pull_request",
    description: "Get a pull request by number.",
    inputSchema: schema(
      {
        owner: str("Repository owner login."),
        pull_number: int("Pull request number."),
        repo: str("Repository name."),
      },
      ["owner", "repo", "pull_number"],
    ),
  },
  {
    name: "search_repositories",
    description: "Search repositories by name or description.",
    inputSchema: schema(
      {
        limit: int("Maximum number of repositories to return (default 30)."),
        query: str("Search query matched against repository name and description."),
      },
      ["query"],
    ),
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcError {
  code: number;
  message: string;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: unknown; result: unknown }
  | { jsonrpc: "2.0"; id: unknown; error: JsonRpcError };

function ok(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

class ToolError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function notFoundError(what: string): ToolError {
  return new ToolError(-32004, `${what} not found`);
}

function requireArgs(args: Record<string, unknown>, required: string[], tool: string): void {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new ToolError(-32602, `Missing required argument: ${key} for tool ${tool}`);
    }
  }
}

function limitOf(args: Record<string, unknown>): number {
  const raw = args.limit;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(1, Math.min(100, Math.floor(raw)));
  return 30;
}

function stateFilterOf(args: Record<string, unknown>): "open" | "closed" | "all" {
  const raw = typeof args.state === "string" ? args.state.toLowerCase() : "open";
  return raw === "closed" || raw === "all" ? raw : "open";
}

// ---------------------------------------------------------------------------
// Tool implementations (operate on the shared store via graphql.ts)
// ---------------------------------------------------------------------------

type ToolImpl = (args: Record<string, unknown>) => unknown;

function toolListRepositories(args: Record<string, unknown>): unknown {
  const limit = limitOf(args);
  const repos: unknown[] = [];
  for (const [key, r] of store.repos.entries()) {
    repos.push(repoToJson({ key, repo: r as any }));
  }
  repos.sort((a, b) => String((a as any).full_name).localeCompare(String((b as any).full_name)));
  return repos.slice(0, limit);
}

function toolGetRepository(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo"], "get_repository");
  const found = findRepo(String(args.owner), String(args.repo));
  if (!found) throw notFoundError(`Repository ${args.owner}/${args.repo}`);
  return repoToJson(found);
}

function toolListIssues(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo"], "list_issues");
  const owner = String(args.owner);
  const repo = String(args.repo);
  if (!findRepo(owner, repo)) throw notFoundError(`Repository ${owner}/${repo}`);
  const state = stateFilterOf(args);
  const limit = limitOf(args);
  return listIssuesForRepo(owner, repo)
    .filter((r) => state === "all" || stateLower(r) === state)
    .slice(0, limit)
    .map((r) => issueToJson(r, owner, repo));
}

function toolCreateIssue(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo", "title"], "create_issue");
  const owner = String(args.owner);
  const repo = String(args.repo);
  if (!findRepo(owner, repo)) throw notFoundError(`Repository ${owner}/${repo}`);
  const rec = createIssueRecord(owner, repo, String(args.title), typeof args.body === "string" ? args.body : null);
  if (!rec) throw notFoundError(`Repository ${owner}/${repo}`);
  return issueToJson(rec, owner, repo);
}

function toolGetIssue(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo", "issue_number"], "get_issue");
  const owner = String(args.owner);
  const repo = String(args.repo);
  const number = Number(args.issue_number);
  if (!findRepo(owner, repo)) throw notFoundError(`Repository ${owner}/${repo}`);
  const rec = listIssuesForRepo(owner, repo).find((r) => issueNumber(r) === number);
  if (!rec) throw notFoundError(`Issue #${number} in ${owner}/${repo}`);
  return issueToJson(rec, owner, repo);
}

function toolListPullRequests(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo"], "list_pull_requests");
  const owner = String(args.owner);
  const repo = String(args.repo);
  if (!findRepo(owner, repo)) throw notFoundError(`Repository ${owner}/${repo}`);
  const state = stateFilterOf(args);
  const limit = limitOf(args);
  return listPRsForRepo(owner, repo)
    .filter((r) => state === "all" || stateLower(r) === state)
    .slice(0, limit)
    .map((r) => prToJson(r, owner, repo));
}

function toolCreatePullRequest(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo", "title", "head", "base"], "create_pull_request");
  const owner = String(args.owner);
  const repo = String(args.repo);
  if (!findRepo(owner, repo)) throw notFoundError(`Repository ${owner}/${repo}`);
  const rec = createPullRequestRecord(
    owner,
    repo,
    String(args.title),
    String(args.head),
    String(args.base),
    typeof args.body === "string" ? args.body : null,
  );
  if (!rec) throw notFoundError(`Repository ${owner}/${repo}`);
  return prToJson(rec, owner, repo);
}

function toolGetPullRequest(args: Record<string, unknown>): unknown {
  requireArgs(args, ["owner", "repo", "pull_number"], "get_pull_request");
  const owner = String(args.owner);
  const repo = String(args.repo);
  const number = Number(args.pull_number);
  if (!findRepo(owner, repo)) throw notFoundError(`Repository ${owner}/${repo}`);
  const rec = listPRsForRepo(owner, repo).find((r) => prNumber(r) === number);
  if (!rec) throw notFoundError(`Pull request #${number} in ${owner}/${repo}`);
  return prToJson(rec, owner, repo);
}

function toolSearchRepositories(args: Record<string, unknown>): unknown {
  requireArgs(args, ["query"], "search_repositories");
  const q = String(args.query).toLowerCase();
  const limit = limitOf(args);
  const hits: unknown[] = [];
  for (const [key, r] of store.repos.entries()) {
    const rr = r as any;
    const hay = `${rr.name ?? ""} ${key} ${rr.description ?? ""}`.toLowerCase();
    if (q === "" || hay.includes(q)) hits.push(repoToJson({ key, repo: rr }));
  }
  hits.sort((a, b) => String((a as any).full_name).localeCompare(String((b as any).full_name)));
  return hits.slice(0, limit);
}

const TOOL_IMPLS: Record<string, ToolImpl> = {
  create_issue: toolCreateIssue,
  create_pull_request: toolCreatePullRequest,
  get_issue: toolGetIssue,
  get_pull_request: toolGetPullRequest,
  get_repo: toolGetRepository,
  get_repository: toolGetRepository,
  list_issues: toolListIssues,
  list_pull_requests: toolListPullRequests,
  list_repos: toolListRepositories,
  list_repositories: toolListRepositories,
  search_repositories: toolSearchRepositories,
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher (pure: no HTTP)
// ---------------------------------------------------------------------------

// Returns null for notifications (no response must be sent).
export function handleMcpRequest(payload: unknown): JsonRpcResponse | null {
  if (Array.isArray(payload)) {
    return fail(null, -32600, "Batch requests are not supported");
  }
  if (!payload || typeof payload !== "object") {
    return fail(null, -32600, "Invalid Request: expected a JSON-RPC object");
  }
  const req = payload as Record<string, unknown>;
  const id = "id" in req ? req.id : undefined;
  const isNotification = id === undefined;
  const method = req.method;

  if (typeof method !== "string") {
    if (isNotification) return null;
    return fail(id ?? null, -32600, "Invalid Request: missing method");
  }

  // Notifications: no response.
  if (isNotification) {
    // notifications/initialized (and any other notification) = no-op.
    return null;
  }

  try {
    switch (method) {
      case "initialize": {
        const params = (req.params ?? {}) as Record<string, unknown>;
        return ok(id, {
          capabilities: { tools: {} },
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: MCP_TOOLS });
      case "tools/call": {
        const params = (req.params ?? {}) as Record<string, unknown>;
        const name = params.name;
        if (typeof name !== "string" || !name) {
          return fail(id, -32602, "Invalid params: tools/call requires a tool name");
        }
        const impl = TOOL_IMPLS[name];
        if (!impl) {
          return fail(id, -32601, `Method not found: unknown tool "${name}"`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== "object" || Array.isArray(args)) {
          return fail(id, -32602, "Invalid params: tools/call arguments must be an object");
        }
        const result = impl(args);
        return ok(id, {
          content: [{ text: JSON.stringify(result), type: "text" }],
          structuredContent: result,
        });
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof ToolError) return fail(id, e.code, e.message);
    return fail(id, -32603, `Internal error: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler (wired by the coordinator to POST /mcp + GET /mcp)
// ---------------------------------------------------------------------------

export async function mcpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    sendJson(res, 200, {
      capabilities: { tools: {} },
      name: MCP_SERVER_NAME,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: MCP_TOOLS.map((t) => t.name),
      version: MCP_SERVER_VERSION,
    });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { code: -32600, message: "Method not allowed: MCP requires POST" }, jsonrpc: "2.0", id: null });
    return;
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, 400, { error: { code: -32700, message: `Parse error: ${parsed.error}` }, jsonrpc: "2.0", id: null });
    return;
  }
  // Auth: a tools/call with no Authorization header answers HTTP 401
  // (kit checks-mcp auth-required). The handshake (initialize) and
  // tools/list are not auth-gated.
  const body = parsed.value as any;
  if (body && body.method === "tools/call") {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !/^Bearer\s+\S+/.test(auth.trim())) {
      sendJson(res, 401, { error: { code: -32000, message: "Requires authentication" }, jsonrpc: "2.0", id: body.id ?? null });
      return;
    }
  }
  const response = handleMcpRequest(parsed.value);
  if (response === null) {
    // Notification: 202 Accepted, no body.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// Routes this module serves, for the coordinator / documentation.
export const MCP_ROUTES: string[] = ["POST /mcp", "GET /mcp"];

// MCP tools implemented, for the coordinator / documentation.
export const MCP_TOOL_NAMES: string[] = MCP_TOOLS.map((t) => t.name);

// Re-exported for tests / introspection.
export const MCP_INFO = {
  createdAt: CREATED_AT,
  name: MCP_SERVER_NAME,
  protocolVersion: MCP_PROTOCOL_VERSION,
  version: MCP_SERVER_VERSION,
};
