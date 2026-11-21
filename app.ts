import type { IncomingMessage, ServerResponse } from "node:http";
import { restRouter } from "./rest.ts";
import { graphqlHandler } from "./graphql.ts";
import { mcpHandler } from "./mcp.ts";
import { gitHttpHandler } from "./git.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Minimal router: method + exact-path table, easy to extend with
// git/REST/GraphQL/MCP routes later.
const routes: Array<{ method: string; path: string; handler: Handler }> = [
  {
    method: "GET",
    path: "/",
    handler: (_req, res) => sendJson(res, 200, { ok: true }),
  },
  {
    method: "GET",
    path: "/health",
    handler: (_req, res) => sendJson(res, 200, { ok: true }),
  },
  {
    // Boot probe: the suite calls GET /healthz twice and requires 200
    // both times within its boot budget (kit wire.ts HEALTHZ_PATH).
    method: "GET",
    path: "/healthz",
    handler: (_req, res) => sendJson(res, 200, { ok: true }),
  },
];

export async function router(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // GraphQL (async): POST /api/graphql and POST /graphql.
  if (
    req.method === "POST" &&
    (pathname === "/api/graphql" || pathname === "/graphql")
  ) {
    await graphqlHandler(req, res);
    return;
  }

  // MCP (async): POST /mcp and GET /mcp.
  if (pathname === "/mcp") {
    await mcpHandler(req, res);
    return;
  }

  // Git smart HTTP (async, returns true when it claims the request).
  if (await gitHttpHandler(req, res)) {
    return;
  }

  // REST v3 (sync, claims its own routes; false = not a REST route).
  if (restRouter(req, res)) {
    return;
  }

  const route = routes.find(
    (r) => r.method === req.method && r.path === pathname,
  );
  if (route) {
    route.handler(req, res);
    return;
  }
  sendJson(res, 404, { ok: false, error: "not_found" });
}
