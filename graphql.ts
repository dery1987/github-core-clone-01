// graphql.ts — Minimal GraphQL endpoint (subset used by gh CLI and
// github-mcp-server) for the GitHub-compatible forge.
//
// Node stdlib only (node:http). No dependencies. Implements a small
// recursive-descent parser + executor for:
//   - query / mutation operations (incl. shorthand `{ ... }`)
//   - fields with arguments, nested selection sets, aliases, variables
//   - named fragments, inline fragments, directives (parsed, ignored)
// It is NOT a full GraphQL implementation — only the shapes gh and
// github-mcp-server actually send (viewer, repository, issues,
// pullRequests, createIssue) are supported.
//
// Reads/writes the shared in-memory store (store.ts). The store's
// minimal interfaces (Repo {name, owner}, Issue {id, repo, title},
// PullRequest {id, repo, title}) lack fields like state/body/number,
// so richer GitHub-shaped records are stored with `as any` casts —
// using the SAME record shape as rest.ts so records created via REST,
// GraphQL, or MCP are interchangeable:
//   issue: {id, number, repo:"owner/name", title, body, state:"open",
//           created_at, updated_at, user:{login}, html_url, url}
//   pr:    {id, number, repo, title, body, state:"open",
//           head:{ref}, base:{ref}, merged:false, ...}
//   repo:  {id, name, owner:{login}|"octocat", description,
//           default_branch:"main", full_name:"owner/name", ...}
// Resolvers tolerate minimal records by falling back to defaults
// (state OPEN, number = id, body "", author = repo owner).
// created_at / updated_at are always the deterministic CREATED_AT.
//
// This module owns no server: the coordinator wires `graphqlHandler`
// into app.ts for POST /api/graphql and POST /graphql. Pure
// `executeGraphQL(query, variables?, operationName?)` is exported for
// tests and for reuse by mcp.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "./store.ts";

// ---------------------------------------------------------------------------
// Deterministic values / shared helpers
// ---------------------------------------------------------------------------

export const CREATED_AT = "2026-01-01T00:00:00Z";
export const VIEWER_LOGIN = "adaiversen";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return { ok: false, error: "Empty request body" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// Store access (tolerant of minimal records written by other modules)
// ---------------------------------------------------------------------------

export interface FoundRepo {
  key: string;
  repo: any;
}

export function findRepo(owner: string, name: string): FoundRepo | null {
  const key = repoKey(owner, name);
  const direct = store.repos.get(key) as any;
  if (direct) return { key, repo: direct };
  for (const [k, r] of store.repos.entries()) {
    const rr = r as any;
    const login = typeof rr.owner === "string" ? rr.owner : rr.owner?.login;
    if (login === owner && rr.name === name) return { key: k, repo: rr };
  }
  return null;
}

// Resolve a repositoryId as passed to createIssue: "owner/name",
// a repo's full_name, or its numeric REST id (string or number).
export function findRepoById(repositoryId: unknown): FoundRepo | null {
  if (typeof repositoryId === "string") {
    if (repositoryId.includes("/")) {
      const [owner, ...rest] = repositoryId.split("/");
      const found = findRepo(owner, rest.join("/"));
      if (found) return found;
    }
    for (const [k, r] of store.repos.entries()) {
      const rr = r as any;
      if (rr.full_name === repositoryId || k === repositoryId) return { key: k, repo: rr };
      if (String(rr.id) === repositoryId) return { key: k, repo: rr };
    }
    return null;
  }
  if (typeof repositoryId === "number") {
    for (const [k, r] of store.repos.entries()) {
      if ((r as any).id === repositoryId) return { key: k, repo: r as any };
    }
  }
  return null;
}

export function repoOwnerLogin(repo: any): string {
  if (typeof repo.owner === "string") return repo.owner;
  if (repo.owner?.login) return repo.owner.login;
  return VIEWER_LOGIN;
}

export function repoDefaultBranch(repo: any): string {
  return repo.default_branch ?? repo.defaultBranch ?? "main";
}

export function issueNumber(rec: any): number {
  return typeof rec.number === "number" ? rec.number : typeof rec.id === "number" ? rec.id : 0;
}

export function prNumber(rec: any): number {
  return issueNumber(rec);
}

// GraphQL enum form: "OPEN" / "CLOSED". Stored records use REST
// lowercase "open" / "closed" (or have no state at all -> OPEN).
export function normalizeState(rec: any): "OPEN" | "CLOSED" {
  const s = String(rec?.state ?? "open").toLowerCase();
  return s === "closed" ? "CLOSED" : "OPEN";
}

export function stateLower(rec: any): "open" | "closed" {
  return normalizeState(rec) === "CLOSED" ? "closed" : "open";
}

function issueMatchesRepo(rec: any, key: string, name: string): boolean {
  return rec.repo === key || rec.repo === name || rec._repoKey === key;
}

export function listIssuesForRepo(owner: string, name: string): any[] {
  const key = repoKey(owner, name);
  return [...store.issues.values()]
    .filter((i) => issueMatchesRepo(i as any, key, name))
    .sort((a, b) => issueNumber(a as any) - issueNumber(b as any));
}

export function listPRsForRepo(owner: string, name: string): any[] {
  const key = repoKey(owner, name);
  return [...store.pullRequests.values()]
    .filter((p) => issueMatchesRepo(p as any, key, name))
    .sort((a, b) => prNumber(a as any) - prNumber(b as any));
}

function nextGlobalId(map: Map<number, unknown>): number {
  let max = 0;
  for (const k of map.keys()) if (typeof k === "number" && k > max) max = k;
  return max + 1;
}

export function createIssueRecord(
  owner: string,
  name: string,
  title: string,
  body?: string | null,
): any | null {
  const found = findRepo(owner, name);
  if (!found) return null;
  const key = found.key;
  const existing = listIssuesForRepo(owner, name);
  const number = existing.reduce((m, r) => Math.max(m, issueNumber(r)), 0) + 1;
  const id = nextGlobalId(store.issues);
  const rec: any = {
    body: typeof body === "string" ? body : null,
    created_at: CREATED_AT,
    html_url: `https://github.com/${key}/issues/${number}`,
    id,
    number,
    repo: key,
    state: "open",
    title,
    updated_at: CREATED_AT,
    url: `https://api.github.com/repos/${key}/issues/${number}`,
    user: { login: VIEWER_LOGIN },
  };
  store.issues.set(id, rec as any);
  return rec;
}

export function createPullRequestRecord(
  owner: string,
  name: string,
  title: string,
  head: string,
  base: string,
  body?: string | null,
): any | null {
  const found = findRepo(owner, name);
  if (!found) return null;
  const key = found.key;
  const existing = listPRsForRepo(owner, name);
  const number = existing.reduce((m, r) => Math.max(m, prNumber(r)), 0) + 1;
  const id = nextGlobalId(store.pullRequests);
  const rec: any = {
    base: { ref: base },
    body: typeof body === "string" ? body : null,
    created_at: CREATED_AT,
    head: { ref: head },
    html_url: `https://github.com/${key}/pull/${number}`,
    id,
    merged: false,
    number,
    repo: key,
    state: "open",
    title,
    updated_at: CREATED_AT,
    url: `https://api.github.com/repos/${key}/pulls/${number}`,
    user: { login: VIEWER_LOGIN },
  };
  store.pullRequests.set(id, rec as any);
  return rec;
}

// ---------------------------------------------------------------------------
// REST-shaped JSON views (used by MCP tools)
// ---------------------------------------------------------------------------

export function repoToJson(found: FoundRepo): Record<string, unknown> {
  const r = found.repo;
  return {
    created_at: r.created_at ?? CREATED_AT,
    default_branch: repoDefaultBranch(r),
    description: r.description ?? null,
    full_name: found.key,
    html_url: r.html_url ?? `https://github.com/${found.key}`,
    id: typeof r.id === "number" ? r.id : found.key,
    name: r.name,
    owner: repoOwnerLogin(r),
    private: r.private === true,
    updated_at: r.updated_at ?? CREATED_AT,
    url: r.url ?? `https://api.github.com/repos/${found.key}`,
  };
}

export function issueToJson(rec: any, owner: string, name: string): Record<string, unknown> {
  const key = repoKey(owner, name);
  const number = issueNumber(rec);
  return {
    body: rec.body ?? null,
    created_at: rec.created_at ?? CREATED_AT,
    html_url: rec.html_url ?? `https://github.com/${key}/issues/${number}`,
    id: rec.id,
    number,
    repository: key,
    state: stateLower(rec),
    title: rec.title,
    updated_at: rec.updated_at ?? CREATED_AT,
    url: rec.url ?? `https://api.github.com/repos/${key}/issues/${number}`,
    user: rec.user?.login ?? rec.author ?? owner,
  };
}

export function prToJson(rec: any, owner: string, name: string): Record<string, unknown> {
  const key = repoKey(owner, name);
  const number = prNumber(rec);
  return {
    base: rec.base?.ref ?? rec.baseRefName ?? rec.base ?? "main",
    body: rec.body ?? null,
    created_at: rec.created_at ?? CREATED_AT,
    head: rec.head?.ref ?? rec.headRefName ?? rec.head ?? "",
    html_url: rec.html_url ?? `https://github.com/${key}/pull/${number}`,
    id: rec.id,
    merged: rec.merged === true,
    number,
    repository: key,
    state: stateLower(rec),
    title: rec.title,
    updated_at: rec.updated_at ?? CREATED_AT,
    url: rec.url ?? `https://api.github.com/repos/${key}/pulls/${number}`,
    user: rec.user?.login ?? rec.author ?? owner,
  };
}

// ---------------------------------------------------------------------------
// GraphQL source objects (what the executor resolves fields against)
// ---------------------------------------------------------------------------

function userSource(login: string): Record<string, unknown> {
  return {
    __typename: "User",
    id: `user:${login}`,
    login,
    url: `https://github.com/${login}`,
  };
}

function repoSource(found: FoundRepo): Record<string, unknown> {
  const r = found.repo;
  const owner = repoOwnerLogin(r);
  const branch = repoDefaultBranch(r);
  return {
    __typename: "Repository",
    createdAt: r.created_at ?? CREATED_AT,
    defaultBranchRef: { __typename: "Ref", name: branch, prefix: "refs/heads/" },
    description: r.description ?? null,
    id: typeof r.id === "number" ? String(r.id) : found.key,
    isPrivate: r.private === true,
    name: r.name,
    nameWithOwner: found.key,
    owner: userSource(owner),
    updatedAt: r.updated_at ?? CREATED_AT,
    url: r.html_url ?? `https://github.com/${found.key}`,
    visibility: r.private === true ? "PRIVATE" : "PUBLIC",
    _key: found.key,
    _owner: owner,
    _name: r.name,
  };
}

function issueSource(rec: any, owner: string, name: string): Record<string, unknown> {
  const key = repoKey(owner, name);
  const number = issueNumber(rec);
  const author = rec.user?.login ?? rec.author ?? owner;
  return {
    __typename: "Issue",
    author: userSource(author),
    body: rec.body ?? null,
    createdAt: rec.created_at ?? CREATED_AT,
    id: `issue:${key}:${number}`,
    number,
    state: normalizeState(rec),
    title: rec.title,
    updatedAt: rec.updated_at ?? CREATED_AT,
    url: rec.html_url ?? `https://github.com/${key}/issues/${number}`,
    _repoKey: key,
  };
}

function prSource(rec: any, owner: string, name: string): Record<string, unknown> {
  const key = repoKey(owner, name);
  const number = prNumber(rec);
  const author = rec.user?.login ?? rec.author ?? owner;
  return {
    __typename: "PullRequest",
    author: userSource(author),
    baseRefName: rec.base?.ref ?? rec.baseRefName ?? rec.base ?? "main",
    body: rec.body ?? null,
    createdAt: rec.created_at ?? CREATED_AT,
    headRefName: rec.head?.ref ?? rec.headRefName ?? rec.head ?? "",
    id: `pr:${key}:${number}`,
    isDraft: false,
    merged: rec.merged === true,
    number,
    state: normalizeState(rec),
    title: rec.title,
    updatedAt: rec.updated_at ?? CREATED_AT,
    url: rec.html_url ?? `https://github.com/${key}/pull/${number}`,
    _repoKey: key,
  };
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = "name" | "string" | "int" | "float" | "punct" | "eof";
interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error("Unterminated block string");
        tokens.push({ kind: "string", value: src.slice(i + 3, end), pos: i });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const esc = src[j + 1] ?? "";
          const map: Record<string, string> = {
            '"': '"',
            "/": "/",
            "\\": "\\",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          out += map[esc] ?? esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error("Unterminated string");
      tokens.push({ kind: "string", value: out, pos: i });
      i = j + 1;
      continue;
    }
    if (c === "." && src.startsWith("...", i)) {
      tokens.push({ kind: "punct", value: "...", pos: i });
      i += 3;
      continue;
    }
    if ("{}()[]:!=$@&|".includes(c)) {
      tokens.push({ kind: "punct", value: c, pos: i });
      i++;
      continue;
    }
    if (c === "-" || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      let isFloat = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        isFloat = true;
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j++;
      tokens.push({ kind: "name", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: "eof", value: "", pos: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: "String"; value: string }
  | { kind: "Int"; value: number }
  | { kind: "Float"; value: number }
  | { kind: "Boolean"; value: boolean }
  | { kind: "Null" }
  | { kind: "Enum"; value: string }
  | { kind: "Variable"; name: string }
  | { kind: "List"; values: ValueNode[] }
  | { kind: "Object"; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: "Field";
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: "FragmentSpread";
  name: string;
}

interface InlineFragmentNode {
  kind: "InlineFragment";
  typeCondition?: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: "Operation";
  operation: "query" | "mutation";
  name?: string;
  variableDefaults: Record<string, ValueNode>;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(v: string): Token {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== v) {
      throw new Error(`Expected "${v}" but got ${JSON.stringify(t.value)} at offset ${t.pos}`);
    }
    return t;
  }
  private expectName(what = "name"): string {
    const t = this.next();
    if (t.kind !== "name") {
      throw new Error(`Expected ${what} but got ${JSON.stringify(t.value)} at offset ${t.pos}`);
    }
    return t.value;
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === v;
  }
  private isName(v: string): boolean {
    const t = this.peek();
    return t.kind === "name" && t.value === v;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== "eof") {
      if (this.isName("fragment")) {
        this.next();
        const name = this.expectName("fragment name");
        if (!this.isName("on")) throw new Error(`Expected "on" in fragment ${name}`);
        this.next();
        this.expectName("fragment type condition");
        doc.fragments.set(name, this.parseSelectionSet());
      } else {
        doc.operations.push(this.parseOperation());
      }
    }
    return doc;
  }

  private parseOperation(): OperationNode {
    let operation: "query" | "mutation" = "query";
    if (this.isPunct("{")) {
      return { kind: "Operation", operation, variableDefaults: {}, selection: this.parseSelectionSet() };
    }
    const kw = this.expectName("query or mutation");
    if (kw !== "query" && kw !== "mutation") {
      throw new Error(`Unsupported operation "${kw}" (only query/mutation)`);
    }
    operation = kw;
    const op: OperationNode = { kind: "Operation", operation, variableDefaults: {}, selection: [] };
    if (this.peek().kind === "name") op.name = this.next().value;
    if (this.isPunct("(")) op.variableDefaults = this.parseVariableDefinitions();
    op.selection = this.parseSelectionSet();
    return op;
  }

  private parseVariableDefinitions(): Record<string, ValueNode> {
    const defs: Record<string, ValueNode> = {};
    this.expectPunct("(");
    while (!this.isPunct(")")) {
      if (this.peek().kind === "eof") throw new Error("Unterminated variable definitions");
      this.expectPunct("$");
      const name = this.expectName("variable name");
      this.expectPunct(":");
      this.parseType();
      if (this.isPunct("=")) {
        this.next();
        defs[name] = this.parseValue();
      }
    }
    this.expectPunct(")");
    return defs;
  }

  // Consume a type reference: Name, [Name], with optional trailing "!".
  private parseType(): void {
    if (this.isPunct("[")) {
      this.next();
      this.parseType();
      this.expectPunct("]");
    } else {
      this.expectName("type name");
    }
    if (this.isPunct("!")) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!this.isPunct("}")) {
      if (this.peek().kind === "eof") throw new Error("Unterminated selection set");
      selections.push(this.parseSelection());
    }
    this.expectPunct("}");
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct("...")) {
      this.next();
      if (this.isName("on")) {
        this.next();
        const typeCondition = this.expectName("type condition");
        this.parseDirectives();
        return { kind: "InlineFragment", typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === "name") {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: "FragmentSpread", name };
      }
      this.parseDirectives();
      return { kind: "InlineFragment", selection: this.parseSelectionSet() };
    }
    const first = this.expectName("field name");
    let name = first;
    let alias: string | undefined;
    if (this.isPunct(":")) {
      this.next();
      alias = first;
      name = this.expectName("field name");
    }
    const field: FieldNode = { kind: "Field", name, args: {} };
    if (alias) field.alias = alias;
    if (this.isPunct("(")) field.args = this.parseArguments();
    this.parseDirectives();
    if (this.isPunct("{")) field.selection = this.parseSelectionSet();
    return field;
  }

  // Directives (@skip/@include/...) are parsed and ignored: this subset
  // does not evaluate them.
  private parseDirectives(): void {
    while (this.isPunct("@")) {
      this.next();
      this.expectName("directive name");
      if (this.isPunct("(")) this.parseArguments();
    }
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct("(");
    while (!this.isPunct(")")) {
      if (this.peek().kind === "eof") throw new Error("Unterminated arguments");
      const name = this.expectName("argument name");
      this.expectPunct(":");
      args[name] = this.parseValue();
    }
    this.expectPunct(")");
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    switch (t.kind) {
      case "string":
        return { kind: "String", value: t.value };
      case "int":
        return { kind: "Int", value: Number.parseInt(t.value, 10) };
      case "float":
        return { kind: "Float", value: Number.parseFloat(t.value) };
      case "punct":
        if (t.value === "$") {
          return { kind: "Variable", name: this.expectName("variable name") };
        }
        if (t.value === "[") {
          const values: ValueNode[] = [];
          while (!this.isPunct("]")) {
            if (this.peek().kind === "eof") throw new Error("Unterminated list");
            values.push(this.parseValue());
          }
          this.expectPunct("]");
          return { kind: "List", values };
        }
        if (t.value === "{") {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.isPunct("}")) {
            if (this.peek().kind === "eof") throw new Error("Unterminated object");
            const name = this.expectName("object field name");
            this.expectPunct(":");
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct("}");
          return { kind: "Object", fields };
        }
        throw new Error(`Unexpected "${t.value}" in value at offset ${t.pos}`);
      case "name":
        if (t.value === "true") return { kind: "Boolean", value: true };
        if (t.value === "false") return { kind: "Boolean", value: false };
        if (t.value === "null") return { kind: "Null" };
        return { kind: "Enum", value: t.value };
      default:
        throw new Error(`Unexpected token ${JSON.stringify(t.value)} in value`);
    }
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "String":
    case "Int":
    case "Float":
    case "Boolean":
      return node.value;
    case "Null":
      return null;
    case "Enum":
      return node.value;
    case "Variable":
      return variables[node.name];
    case "List":
      return node.values.map((v) => valueFromAst(v, variables));
    case "Object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromAst(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = valueFromAst(v, ctx.variables);
  return out;
}

function applySelection(value: unknown, selection: SelectionNode[] | undefined, ctx: Ctx): unknown {
  if (!selection) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => applySelection(v, selection, ctx));
  if (typeof value === "object") return executeSelectionSet(selection, value as Record<string, unknown>, ctx);
  return value;
}

function executeSelectionSet(
  selection: SelectionNode[],
  source: Record<string, unknown>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === "FragmentSpread") {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}"` });
        continue;
      }
      Object.assign(out, executeSelectionSet(frag, source, ctx));
      continue;
    }
    if (sel.kind === "InlineFragment") {
      if (sel.typeCondition && source.__typename !== sel.typeCondition) continue;
      Object.assign(out, executeSelectionSet(sel.selection, source, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === "__typename") {
      out[key] = source.__typename ?? null;
      continue;
    }
    const resolved = resolveField(source, sel, ctx);
    out[key] = applySelection(resolved, sel.selection, ctx);
  }
  return out;
}

function buildConnection(
  items: Record<string, unknown>[],
  args: Record<string, unknown>,
  connectionType: string,
  edgeType: string,
): Record<string, unknown> {
  const first = typeof args.first === "number" ? Math.max(0, args.first) : undefined;
  const sliced = first === undefined ? items : items.slice(0, first);
  const edges = sliced.map((node, i) => ({
    __typename: edgeType,
    cursor: `cursor:${(node.number as number | undefined) ?? i}`,
    node,
  }));
  return {
    __typename: connectionType,
    edges,
    nodes: sliced,
    pageInfo: {
      __typename: "PageInfo",
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
      hasNextPage: first !== undefined && items.length > first,
      hasPreviousPage: false,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
    },
    totalCount: items.length,
  };
}

function parseStatesArg(args: Record<string, unknown>): Set<string> | null {
  const raw = args.states;
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  return new Set(list.map((s) => String(s).toUpperCase()));
}

function resolveField(source: Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const typename = String(source.__typename ?? "");
  const args = resolveArgs(field.args, ctx);
  const name = field.name;

  // Root Query
  if (typename === "Query") {
    if (name === "viewer") return userSource(VIEWER_LOGIN);
    if (name === "repository") {
      const owner = args.owner;
      const repoName = args.name;
      if (typeof owner !== "string" || typeof repoName !== "string") {
        ctx.errors.push({ message: 'repository requires string arguments "owner" and "name"' });
        return null;
      }
      const found = findRepo(owner, repoName);
      return found ? repoSource(found) : null;
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Query"` });
    return null;
  }

  // Root Mutation
  if (typename === "Mutation") {
    if (name === "createIssue") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const title = input.title;
      if (typeof title !== "string" || !title) {
        ctx.errors.push({ message: "createIssue requires input.title" });
        return null;
      }
      const found = findRepoById(input.repositoryId);
      if (!found) {
        ctx.errors.push({ message: `Repository not found: ${String(input.repositoryId ?? "")}` });
        return null;
      }
      const rec = createIssueRecord(repoOwnerLogin(found.repo), found.repo.name, title, typeof input.body === "string" ? input.body : null);
      // createIssueRecord re-looks the repo up by owner/name; it cannot
      // fail here because findRepoById already found it.
      if (!rec) {
        ctx.errors.push({ message: `Repository not found: ${String(input.repositoryId ?? "")}` });
        return null;
      }
      return {
        __typename: "CreateIssuePayload",
        issue: issueSource(rec, repoOwnerLogin(found.repo), found.repo.name),
      };
    }
    if (name === "createPullRequest") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const title = input.title;
      const head = input.headRefName ?? input.head;
      const base = input.baseRefName ?? input.base;
      if (typeof title !== "string" || !title || typeof head !== "string" || typeof base !== "string") {
        ctx.errors.push({ message: "createPullRequest requires input.title, input.headRefName and input.baseRefName" });
        return null;
      }
      const found = findRepoById(input.repositoryId);
      if (!found) {
        ctx.errors.push({ message: `Repository not found: ${String(input.repositoryId ?? "")}` });
        return null;
      }
      const rec = createPullRequestRecord(repoOwnerLogin(found.repo), found.repo.name, title, head, base, typeof input.body === "string" ? input.body : null);
      if (!rec) {
        ctx.errors.push({ message: `Repository not found: ${String(input.repositoryId ?? "")}` });
        return null;
      }
      return {
        __typename: "CreatePullRequestPayload",
        pullRequest: prSource(rec, repoOwnerLogin(found.repo), found.repo.name),
      };
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation"` });
    return null;
  }

  // Repository
  if (typename === "Repository") {
    if (name === "issues" || name === "pullRequests") {
      const owner = String(source._owner ?? "");
      const repoName = String(source._name ?? "");
      const states = parseStatesArg(args);
      if (name === "issues") {
        let items = listIssuesForRepo(owner, repoName).map((r) => issueSource(r, owner, repoName));
        if (states) items = items.filter((i) => states.has(String(i.state)));
        return buildConnection(items, args, "IssueConnection", "IssueEdge");
      }
      let items = listPRsForRepo(owner, repoName).map((r) => prSource(r, owner, repoName));
      if (states) items = items.filter((p) => states.has(String(p.state)));
      return buildConnection(items, args, "PullRequestConnection", "PullRequestEdge");
    }
    // owner / defaultBranchRef are already materialised on the source.
  }

  // Issue / PullRequest: repository back-reference.
  if ((typename === "Issue" || typename === "PullRequest") && name === "repository") {
    const key = String(source._repoKey ?? "");
    if (!key.includes("/")) return null;
    const [owner, ...rest] = key.split("/");
    const found = findRepo(owner, rest.join("/"));
    return found ? repoSource(found) : null;
  }

  // Generic fallback: materialised property on the source object.
  if (name in source) return source[name];
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typename || "Unknown"}"` });
  return null;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(
  query: string,
  variables: Record<string, unknown> = {},
  operationName?: string,
): GraphQLResult {
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(e as Error).message}` }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: "GraphQL syntax error: no operation found" }] };
  }
  let op: OperationNode | undefined;
  if (operationName) {
    op = doc.operations.find((o) => o.name === operationName);
    if (!op) return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
  } else if (doc.operations.length === 1) {
    op = doc.operations[0]!;
  } else {
    return {
      data: null,
      errors: [{ message: "Must provide operation name if query contains multiple operations" }],
    };
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op.variableDefaults)) {
    mergedVariables[k] = valueFromAst(v, variables);
  }
  for (const [k, v] of Object.entries(variables ?? {})) {
    if (v !== undefined) mergedVariables[k] = v;
  }
  const ctx: Ctx = { variables: mergedVariables, fragments: doc.fragments, errors: [] };
  const root: Record<string, unknown> = {
    __typename: op.operation === "mutation" ? "Mutation" : "Query",
  };
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(op.selection, root, ctx);
  } catch (e) {
    return { data: null, errors: [{ message: `GraphQL execution error: ${(e as Error).message}` }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler (wired by the coordinator to POST /api/graphql + /graphql)
// ---------------------------------------------------------------------------

export async function graphqlHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { errors: [{ message: "Method not allowed: GraphQL requires POST" }] });
    return;
  }
  // Auth: an unauthenticated query is a 401 (kit checks-graphql).
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !/^Bearer\s+\S+/.test(auth.trim())) {
    sendJson(res, 401, { errors: [{ message: "Requires authentication" }] });
    return;
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: parsed.error }] });
    return;
  }
  const body = parsed.value as any;
  if (!body || typeof body.query !== "string") {
    sendJson(res, 400, { errors: [{ message: "Missing 'query' string in request body" }] });
    return;
  }
  const variables = body.variables && typeof body.variables === "object" ? body.variables : {};
  const operationName = typeof body.operationName === "string" ? body.operationName : undefined;
  sendJson(res, 200, executeGraphQL(body.query, variables, operationName));
}

// Routes this module serves, for the coordinator / documentation.
export const GRAPHQL_ROUTES: string[] = ["POST /api/graphql", "POST /graphql"];

// GraphQL fields implemented, for the coordinator / documentation.
export const GRAPHQL_FIELDS: string[] = [
  "Query.viewer { login, id, url }",
  "Query.repository(owner, name) { id, name, nameWithOwner, description, url, isPrivate, visibility, createdAt, updatedAt, owner { login }, defaultBranchRef { name, prefix }, issues(first, states) { nodes, edges { node, cursor }, totalCount, pageInfo }, pullRequests(first, states) { nodes, edges { node, cursor }, totalCount, pageInfo } }",
  "Issue { id, number, title, body, state, createdAt, updatedAt, url, author { login }, repository }",
  "PullRequest { id, number, title, body, state, createdAt, updatedAt, url, headRefName, baseRefName, isDraft, merged, author { login }, repository }",
  "Mutation.createIssue(input: {repositoryId, title, body}) { issue { ... } }",
  "Mutation.createPullRequest(input: {repositoryId, title, headRefName, baseRefName, body}) { pullRequest { ... } }",
];
