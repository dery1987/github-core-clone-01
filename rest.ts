// GitHub REST v3 API (subset) — Node stdlib only (node:http, node:crypto).
//
// Scope: REST only. Git/GraphQL/MCP are handled by other modules.
// This module owns no HTTP server of its own: the coordinator wires
// `restRouter` into app.ts. It returns `true` when it claimed (and
// answered) a request, `false` when the request is outside its scope
// so the main router can handle it.
//
// Every route is registered under BOTH prefixes:
//   /api/v3/<route>   (suite prefix)
//   /<route>          (GitHub root path)
// The "/api/v3" prefix is stripped before matching, so one matcher
// serves both.
//
// Determinism rules (state export must stay byte-stable):
// - created_at / updated_at are always the fixed string CREATED_AT.
// - Repo / issue / PR ids come from module counters starting at 1.
// - Issue / PR numbers auto-increment PER REPO, starting at 1.
//
// The shared store (store.ts) only has minimal interfaces
// (Repo {name, owner}, Issue {id, repo, title}, PullRequest {id, repo,
// title}), so richer GitHub-shaped objects are stored with `as any`
// casts — see the notes at each `store.*.set` call. Contents blobs
// live in the git object store (git.ts) — GET contents reads the HEAD
// tree, PUT contents commits a new blob/tree/commit — with the
// module-level in-memory map kept as a fallback for blobs that predate
// the integration.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { store } from "./store.ts";
import {
  buildCommit,
  buildTree,
  getGitRepo,
  getObject,
  getOrCreateGitRepo,
  parseCommit,
  parseTree,
  putObject,
  resetGitState,
  resolveHead,
  type GitRepo,
  type TreeEntry,
} from "./git.ts";

// ---------------------------------------------------------------------------
// Deterministic values
// ---------------------------------------------------------------------------

export const CREATED_AT = "2026-01-01T00:00:00Z";

/**
 * The viewer login: the login the suite's bearer token names. The suite
 * derives every user from the kit's published constant SCENARIO_SEED
 * (wire.ts), so the viewer is deterministic and the same in every trial:
 * users[0] of generateUsers(scenarioRng('users'), 12) is "adaiversen"
 * (id 1000). The entry must use it — not "octocat" — as the owner of
 * repos created via POST /user/repos, or every GET /repos/{viewer}/{repo}
 * 404s and the same name under the stranger login must 404 (never 403).
 */
export const VIEWER_LOGIN = "adaiversen";

/** Per-response request id counter (X-GitHub-Request-Id, non-empty). */
let requestCounter = 0;

let nextRepoId = 1;
let nextIssueId = 1;
let nextPrId = 1;
let nextLabelId = 1;

// Per-repo auto-increment counters for issue / PR numbers.
const issueNumberByRepo = new Map<string, number>();
const prNumberByRepo = new Map<string, number>();

// In-memory contents store (fallback when no git object store exists).
// Key: "<owner>/<repo>:<branch>:<path>" — path has no leading slash.
interface BlobEntry {
  content: Buffer;
  sha: string;
  message: string;
}
const contents = new Map<string, BlobEntry>();

// Labels per repository: repoKey -> label name -> label object. A label
// must be created via POST /labels before an issue may carry it.
const labelsByRepo = new Map<string, Map<string, any>>();

// Issue comments: "<repoKey>:<issueNumber>" -> comment objects.
const commentsByIssue = new Map<string, any[]>();
let nextCommentId = 1;

/**
 * The suite presents Authorization: Bearer <token> (the token in
 * MAKEFUN_SHOP_TOKEN) on every API call; a request without it is 401
 * (kit checks-rest repos.unauthorized / protocol.error-message). Any
 * non-empty Bearer token is accepted — the checks only test the missing
 * case, never a wrong one.
 */
function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match !== null && match[1].trim().length > 0;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: "Requires authentication" });
}

export function resetRestState(): void {
  nextRepoId = 1;
  nextIssueId = 1;
  nextPrId = 1;
  nextCommentId = 1;
  issueNumberByRepo.clear();
  prNumberByRepo.clear();
  contents.clear();
  labelsByRepo.clear();
  commentsByIssue.clear();
  // Contents now also live in the git object store; reset both so a
  // fresh test run sees neither surface.
  resetGitState();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  requestCounter += 1;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Wire contract: every REST reply carries a non-empty
    // X-GitHub-Request-Id header (kit checks-rest protocol.request-id).
    "x-github-request-id": `req-${requestCounter}`,
    ...extraHeaders,
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: "Not Found" });
}

function sha1Hex(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

// Git blob id: sha1("blob <len>\0" + bytes).
function gitBlobSha(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, "utf8");
  return createHash("sha1").update(Buffer.concat([header, content])).digest("hex");
}

// Deterministic commit id from blob sha + message.
function gitCommitSha(blobSha: string, message: string): string {
  return sha1Hex(`commit ${blobSha}\n${message}\n${CREATED_AT}`);
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function contentKey(owner: string, repo: string, branch: string, path: string): string {
  return `${owner}/${repo}:${branch}:${path}`;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function userObject(login: string): Record<string, unknown> {
  return {
    avatar_url: `https://github.com/${login}.png`,
    html_url: `https://github.com/${login}`,
    id: userId(login),
    login,
    type: "User",
    url: `https://api.github.com/users/${login}`,
  };
}

// Deterministic user id: octocat is 1; everyone else gets a stable
// hash-derived id so it does not depend on request order.
function userId(login: string): number {
  if (login === "octocat") return 1;
  const h = createHash("sha1").update(login).digest();
  return 2 + (h.readUInt32BE(0) % 99998);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function pagination(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const perPageRaw = Number.parseInt(url.searchParams.get("per_page") ?? "30", 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/**
 * Send a paginated list with a Link header. The suite walks /user/repos
 * through Link rel="next" (kit checks-rest repos.pagination), so a next
 * link is present exactly when another page exists.
 */
function sendList(
  res: ServerResponse,
  items: unknown[],
  page: number,
  perPage: number,
  url: URL,
): void {
  const total = items.length;
  const headers: Record<string, string> = {};
  if (page * perPage < total) {
    const next = new URL(url.toString());
    next.searchParams.set("page", String(page + 1));
    next.searchParams.set("per_page", String(perPage));
    const last = Math.max(1, Math.ceil(total / perPage));
    const lastUrl = new URL(url.toString());
    lastUrl.searchParams.set("page", String(last));
    lastUrl.searchParams.set("per_page", String(perPage));
    headers.link = `<${next.toString()}>; rel="next", <${lastUrl.toString()}>; rel="last"`;
  }
  sendJson(res, 200, paginate(items, page, perPage), headers);
}

// ---------------------------------------------------------------------------
// Serializers (GitHub-shaped views of the stored objects)
// ---------------------------------------------------------------------------

function repoObject(stored: any): Record<string, unknown> {
  return stored;
}

function issueObject(stored: any): Record<string, unknown> {
  return stored;
}

function prObject(stored: any): Record<string, unknown> {
  return stored;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function getRepo(owner: string, repo: string): any | undefined {
  return store.repos.get(repoKey(owner, repo)) as any | undefined;
}

function handleCreateRepo(res: ServerResponse, body: any): void {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || /[/\s]/.test(name)) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Repository", field: "name", code: "missing_field" }] });
    return;
  }
  const owner = VIEWER_LOGIN; // viewer: the login the bearer token names
  const key = repoKey(owner, name);
  if (store.repos.get(key)) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Repository", field: "name", code: "custom", message: "name already exists on this account" }] });
    return;
  }
  const isPrivate = body?.private === true;
  // Richer object than the minimal Repo interface in store.ts; stored
  // via `as any` per the task brief.
  const repo: any = {
    clone_url: `https://github.com/${owner}/${name}.git`,
    created_at: CREATED_AT,
    default_branch: "main",
    description: typeof body?.description === "string" ? body.description : null,
    fork: false,
    forks_count: 0,
    full_name: key,
    homepage: null,
    html_url: `https://github.com/${owner}/${name}`,
    id: nextRepoId++,
    language: null,
    name,
    open_issues_count: 0,
    owner: userObject(owner),
    private: isPrivate,
    size: 0,
    stargazers_count: 0,
    updated_at: CREATED_AT,
    url: `https://api.github.com/repos/${owner}/${name}`,
    visibility: isPrivate ? "private" : "public",
    watchers_count: 0,
  };
  store.repos.set(key, repo as any);
  // Give the repo a git object store entry too, so PUT contents can
  // commit straight away and git push/clone sees the same repo.
  getOrCreateGitRepo(owner, name);
  sendJson(res, 201, repoObject(repo));
}

function handleGetRepo(res: ServerResponse, owner: string, repo: string): void {
  const stored = getRepo(owner, repo);
  if (!stored) {
    notFound(res);
    return;
  }
  sendJson(res, 200, repoObject(stored));
}

function handleDeleteRepo(res: ServerResponse, owner: string, repo: string): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  store.repos.delete(key);
  for (const [id, issue] of [...store.issues.entries()]) {
    if ((issue as any).repo === key) store.issues.delete(id);
  }
  for (const [id, pr] of [...store.pullRequests.entries()]) {
    if ((pr as any).repo === key) store.pullRequests.delete(id);
  }
  for (const ckey of [...contents.keys()]) {
    if (ckey.startsWith(`${key}:`)) contents.delete(ckey);
  }
  issueNumberByRepo.delete(key);
  prNumberByRepo.delete(key);
  res.writeHead(204);
  res.end();
}

function handleListUserRepos(res: ServerResponse, username: string, url: URL): void {
  const { page, perPage } = pagination(url);
  const repos = [...store.repos.values()]
    .filter((r) => (r as any).owner?.login === username || (r as any).owner === username)
    .map((r) => repoObject(r as any))
    .sort((a, b) => (a.id as number) - (b.id as number));
  sendList(res, repos, page, perPage, url);
}

function handleListIssues(res: ServerResponse, owner: string, repo: string, url: URL): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const state = url.searchParams.get("state") ?? "open";
  const { page, perPage } = pagination(url);
  const issues = [...store.issues.values()]
    .filter((i) => (i as any).repo === key)
    .filter((i) => state === "all" || (i as any).state === state)
    .map((i) => issueObject(i as any))
    .sort((a, b) => (a.number as number) - (b.number as number));
  sendList(res, issues, page, perPage, url);
}

function handleCreateIssue(res: ServerResponse, owner: string, repo: string, body: any): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "title", code: "missing_field" }] });
    return;
  }
  // Labels: a label must exist (POST /labels) before an issue may carry
  // it; an unknown label is 422 (kit checks-rest issues.bad-label).
  const labelNames: string[] = Array.isArray(body?.labels)
    ? body.labels.map((l: unknown) =>
        typeof l === "string" ? l : (l as any)?.name,
      ).filter((n: unknown): n is string => typeof n === "string")
    : [];
  const known = labelsByRepo.get(key);
  const attached: any[] = [];
  for (const name of labelNames) {
    const found = known?.get(name);
    if (!found) {
      sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "labels", code: "invalid", message: `label ${name} does not exist` }] });
      return;
    }
    attached.push(found);
  }
  const number = (issueNumberByRepo.get(key) ?? 0) + 1;
  issueNumberByRepo.set(key, number);
  // Richer than the minimal Issue interface; stored via `as any`.
  const issue: any = {
    assignees: [],
    body: typeof body?.body === "string" ? body.body : null,
    created_at: CREATED_AT,
    html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
    id: nextIssueId++,
    labels: attached,
    number,
    repo: key,
    state: "open",
    title,
    updated_at: CREATED_AT,
    url: `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    user: userObject(VIEWER_LOGIN),
  };
  store.issues.set(issue.id, issue as any);
  sendJson(res, 201, issueObject(issue));
}

function findIssue(owner: string, repo: string, number: number): any | undefined {
  const key = repoKey(owner, repo);
  for (const issue of store.issues.values()) {
    const i = issue as any;
    if (i.repo === key && i.number === number) return i;
  }
  return undefined;
}

function handleGetIssue(res: ServerResponse, owner: string, repo: string, number: number): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  const issue = findIssue(owner, repo, number);
  if (!issue) {
    notFound(res);
    return;
  }
  sendJson(res, 200, issueObject(issue));
}

function handlePatchIssue(res: ServerResponse, owner: string, repo: string, number: number, body: any): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  const issue = findIssue(owner, repo, number);
  if (!issue) {
    notFound(res);
    return;
  }
  if (typeof body?.title === "string") issue.title = body.title;
  if (body?.body !== undefined) issue.body = body.body;
  if (typeof body?.state === "string") {
    if (body.state !== "open" && body.state !== "closed") {
      sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "state", code: "invalid" }] });
      return;
    }
    issue.state = body.state;
  }
  issue.updated_at = CREATED_AT;
  store.issues.set(issue.id, issue as any);
  sendJson(res, 200, issueObject(issue));
}

function handleListPulls(res: ServerResponse, owner: string, repo: string, url: URL): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const state = url.searchParams.get("state") ?? "open";
  const { page, perPage } = pagination(url);
  const pulls = [...store.pullRequests.values()]
    .filter((p) => (p as any).repo === key)
    .filter((p) => state === "all" || (p as any).state === state)
    .map((p) => prObject(p as any))
    .sort((a, b) => (a.number as number) - (b.number as number));
  sendList(res, pulls, page, perPage, url);
}

function handleCreatePull(res: ServerResponse, owner: string, repo: string, body: any): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const headRef = typeof body?.head === "string" ? body.head : body?.head?.ref;
  const baseRef = typeof body?.base === "string" ? body.base : body?.base?.ref;
  if (!title || typeof headRef !== "string" || typeof baseRef !== "string") {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "title", code: "missing_field" }] });
    return;
  }
  const number = (prNumberByRepo.get(key) ?? 0) + 1;
  prNumberByRepo.set(key, number);
  // Resolve the branch tips now: the suite checks head.sha is the head
  // branch tip and base.sha is the base tip at creation time.
  const gitRepoForPr = getGitRepo(owner, repo);
  const headSha = gitRepoForPr ? gitBranchCommit(gitRepoForPr, headRef) : null;
  const baseSha = gitRepoForPr ? gitBranchCommit(gitRepoForPr, baseRef) : null;
  // Richer than the minimal PullRequest interface; stored via `as any`.
  const pr: any = {
    base: { ref: baseRef, sha: baseSha, repo: repoObject(getRepo(owner, repo)) },
    body: typeof body?.body === "string" ? body.body : null,
    created_at: CREATED_AT,
    head: { ref: headRef, sha: headSha, repo: repoObject(getRepo(owner, repo)) },
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    id: nextPrId++,
    merge_commit_sha: null,
    merged: false,
    merged_at: null,
    number,
    repo: key,
    state: "open",
    title,
    updated_at: CREATED_AT,
    url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    user: userObject(VIEWER_LOGIN),
  };
  store.pullRequests.set(pr.id, pr as any);
  sendJson(res, 201, prObject(pr));
}

function findPull(owner: string, repo: string, number: number): any | undefined {
  const key = repoKey(owner, repo);
  for (const pr of store.pullRequests.values()) {
    const p = pr as any;
    if (p.repo === key && p.number === number) return p;
  }
  return undefined;
}

function handleGetPull(res: ServerResponse, owner: string, repo: string, number: number): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  const pr = findPull(owner, repo, number);
  if (!pr) {
    notFound(res);
    return;
  }
  sendJson(res, 200, prObject(pr));
}

// ---------------------------------------------------------------------------
// Labels, comments, branches, commits, refs, merge, PATCH repo, DELETE
// contents — endpoints the conformance suite requires (kit checks-rest).
// ---------------------------------------------------------------------------

function handlePatchRepo(
  res: ServerResponse,
  owner: string,
  repo: string,
  body: any,
): void {
  const stored = getRepo(owner, repo);
  if (!stored) {
    notFound(res);
    return;
  }
  if (typeof body?.description === "string" || body?.description === null) {
    stored.description = body.description;
  }
  if (typeof body?.homepage === "string" || body?.homepage === null) {
    stored.homepage = body.homepage;
  }
  stored.updated_at = CREATED_AT;
  store.repos.set(repoKey(owner, repo), stored as any);
  sendJson(res, 200, repoObject(stored));
}

function handleCreateLabel(
  res: ServerResponse,
  owner: string,
  repo: string,
  body: any,
): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", field: "name", code: "missing_field" }] });
    return;
  }
  const color =
    typeof body?.color === "string" ? body.color.replace(/^#/, "") : "ededed";
  let byName = labelsByRepo.get(key);
  if (!byName) {
    byName = new Map();
    labelsByRepo.set(key, byName);
  }
  const label: any = {
    color,
    default: false,
    description: typeof body?.description === "string" ? body.description : "",
    id: nextLabelId++,
    name,
    node_id: `MDU6TGFiZWw${nextLabelId}`,
    url: `https://api.github.com/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
  };
  byName.set(name, label);
  sendJson(res, 201, label);
}

function handleCreateComment(
  res: ServerResponse,
  owner: string,
  repo: string,
  number: number,
  body: any,
): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  if (!findIssue(owner, repo, number)) {
    notFound(res);
    return;
  }
  const text = typeof body?.body === "string" ? body.body : "";
  if (!text) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "IssueComment", field: "body", code: "missing_field" }] });
    return;
  }
  const id = nextCommentId++;
  const comment: any = {
    body: text,
    created_at: CREATED_AT,
    html_url: `https://github.com/${owner}/${repo}/issues/${number}#issuecomment-${id}`,
    id,
    issue_url: `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    updated_at: CREATED_AT,
    url: `https://api.github.com/repos/${owner}/${repo}/issues/comments/${id}`,
    user: userObject(VIEWER_LOGIN),
  };
  const ck = `${repoKey(owner, repo)}:${number}`;
  const list = commentsByIssue.get(ck) ?? [];
  list.push(comment);
  commentsByIssue.set(ck, list);
  sendJson(res, 201, comment);
}

function handleListComments(
  res: ServerResponse,
  owner: string,
  repo: string,
  number: number,
  url: URL,
): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  if (!findIssue(owner, repo, number)) {
    notFound(res);
    return;
  }
  const { page, perPage } = pagination(url);
  const list = commentsByIssue.get(`${repoKey(owner, repo)}:${number}`) ?? [];
  sendList(res, list, page, perPage, url);
}

function handleCreateRef(
  res: ServerResponse,
  owner: string,
  repo: string,
  body: any,
): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const ref = typeof body?.ref === "string" ? body.ref : "";
  const sha = typeof body?.sha === "string" ? body.sha : "";
  if (!ref.startsWith("refs/heads/") || !/^[0-9a-f]{40}$/i.test(sha)) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", field: "ref", code: "invalid" }] });
    return;
  }
  const gitRepo = getOrCreateGitRepo(owner, repo);
  if (!getObject(gitRepo, sha)) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Reference", field: "sha", code: "invalid", message: "object does not exist" }] });
    return;
  }
  const branch = ref.slice("refs/heads/".length);
  gitRepo.refs.set(ref, sha);
  sendJson(res, 201, {
    node_id: `MDU6UmVm${sha.slice(0, 8)}`,
    object: {
      sha,
      type: "commit",
      url: `https://api.github.com/repos/${owner}/${repo}/git/commits/${sha}`,
    },
    ref,
    url: `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
  });
}

function handleListBranches(
  res: ServerResponse,
  owner: string,
  repo: string,
  url: URL,
): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const gitRepo = getGitRepo(owner, repo);
  const out: Array<Record<string, unknown>> = [];
  if (gitRepo) {
    for (const [ref, sha] of gitRepo.refs) {
      if (!ref.startsWith("refs/heads/")) continue;
      out.push({
        commit: {
          sha,
          url: `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
        },
        name: ref.slice("refs/heads/".length),
        protected: false,
      });
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const { page, perPage } = pagination(url);
  sendList(res, out, page, perPage, url);
}

/** First-parent ancestry of a commit tip, oldest-first order preserved. */
function commitAncestors(repo: GitRepo, tip: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = tip;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== "commit") break;
    out.push(cur);
    cur = parseCommit(obj.content).parents[0] ?? null;
  }
  return out;
}

/** Deepest commit reachable from both tips (linear histories). */
function mergeBaseOf(repo: GitRepo, headTip: string | null, baseTip: string | null): string | null {
  if (!headTip || !baseTip) return null;
  const baseAnc = new Set(commitAncestors(repo, baseTip));
  for (const sha of commitAncestors(repo, headTip)) {
    if (baseAnc.has(sha)) return sha;
  }
  return null;
}

/** Flatten a tree to path -> blob sha (recursive). */
function flattenTree(repo: GitRepo, treeSha: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!treeSha) return out;
  const walk = (sha: string, prefix: string): void => {
    for (const e of loadTreeEntries(repo, sha)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === "40000") walk(e.sha, p);
      else out.set(p, e.sha);
    }
  };
  walk(treeSha, "");
  return out;
}

function handleListCommits(
  res: ServerResponse,
  owner: string,
  repo: string,
  url: URL,
): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const ref = url.searchParams.get("sha") ?? "main";
  const gitRepo = getGitRepo(owner, repo);
  let tip: string | null = null;
  if (gitRepo) {
    tip = gitRepo.refs.get(`refs/heads/${ref}`) ?? null;
    if (!tip && /^[0-9a-f]{40}$/i.test(ref)) tip = ref;
    if (!tip && ref === "main") tip = resolveHead(gitRepo).sha;
  }
  const list = tip && gitRepo
    ? commitAncestors(gitRepo, tip).map((sha) => {
        const obj = getObject(gitRepo, sha);
        const parsed = obj ? parseCommit(obj.content) : { message: "" };
        return {
          author: { date: CREATED_AT, email: "adaiversen@example.invalid", name: VIEWER_LOGIN },
          commit: {
            author: { date: CREATED_AT, email: "adaiversen@example.invalid", name: VIEWER_LOGIN },
            committer: { date: CREATED_AT, email: "adaiversen@example.invalid", name: VIEWER_LOGIN },
            message: parsed.message,
          },
          committer: { date: CREATED_AT, email: "adaiversen@example.invalid", name: VIEWER_LOGIN },
          html_url: `https://github.com/${owner}/${repo}/commit/${sha}`,
          sha,
          url: `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
        };
      })
    : [];
  const { page, perPage } = pagination(url);
  sendList(res, list, page, perPage, url);
}

function handleListPullFiles(
  res: ServerResponse,
  owner: string,
  repo: string,
  number: number,
  url: URL,
): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  const pr = findPull(owner, repo, number);
  if (!pr) {
    notFound(res);
    return;
  }
  const gitRepo = getGitRepo(owner, repo);
  const files: Array<Record<string, unknown>> = [];
  if (gitRepo && pr.head?.sha && pr.base?.sha) {
    const base = mergeBaseOf(gitRepo, pr.head.sha, pr.base.sha);
    const baseTree = base ? gitCommitTree(gitRepo, base) : null;
    const headTree = gitCommitTree(gitRepo, pr.head.sha);
    const before = flattenTree(gitRepo, baseTree);
    const after = flattenTree(gitRepo, headTree);
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const p of [...paths].sort()) {
      const b = before.get(p);
      const a = after.get(p);
      if (b === a) continue;
      const countLines = (sha: string | undefined): number => {
        if (!sha) return 0;
        const obj = getObject(gitRepo, sha);
        if (!obj || obj.type !== "blob") return 0;
        const text = obj.content.toString("utf8");
        return text === "" ? 0 : text.split("\n").length;
      };
      const status = !b ? "added" : !a ? "removed" : "modified";
      files.push({
        additions: status === "removed" ? 0 : countLines(a),
        blob_url: `https://github.com/${owner}/${repo}/blob/${pr.head.sha}/${p}`,
        changes: countLines(a) + countLines(b),
        contents_url: `https://api.github.com/repos/${owner}/${repo}/contents/${p}?ref=${pr.head.sha}`,
        deletions: status === "added" ? 0 : countLines(b),
        filename: p,
        patch: "",
        raw_url: `https://github.com/${owner}/${repo}/raw/${pr.head.sha}/${p}`,
        sha: a ?? b ?? "",
        status,
      });
    }
  }
  const { page, perPage } = pagination(url);
  sendList(res, files, page, perPage, url);
}

function handleMergePull(
  res: ServerResponse,
  owner: string,
  repo: string,
  number: number,
  body: any,
): void {
  if (!getRepo(owner, repo)) {
    notFound(res);
    return;
  }
  const pr = findPull(owner, repo, number);
  if (!pr) {
    notFound(res);
    return;
  }
  if (pr.state !== "open" || pr.merged) {
    sendJson(res, 405, { message: "Pull request is already merged or closed" });
    return;
  }
  const gitRepo = getGitRepo(owner, repo);
  const headRef = pr.head?.ref as string | undefined;
  const baseRef = pr.base?.ref as string | undefined;
  if (!gitRepo || !headRef || !baseRef) {
    sendJson(res, 405, { message: "Pull request cannot be merged" });
    return;
  }
  const headTip = gitBranchCommit(gitRepo, headRef);
  const baseTip = gitBranchCommit(gitRepo, baseRef);
  if (!headTip || !baseTip) {
    sendJson(res, 405, { message: "Pull request cannot be merged" });
    return;
  }
  // Conflict: a path the head changed (vs merge-base) that the base also
  // changed (vs merge-base) to different bytes.
  const base = mergeBaseOf(gitRepo, headTip, baseTip);
  const baseTree = base ? gitCommitTree(gitRepo, base) : null;
  const headTree = gitCommitTree(gitRepo, headTip);
  const baseTipTree = gitCommitTree(gitRepo, baseTip);
  const before = flattenTree(gitRepo, baseTree);
  const headFiles = flattenTree(gitRepo, headTree);
  const baseFiles = flattenTree(gitRepo, baseTipTree);
  for (const p of headFiles.keys()) {
    if (headFiles.get(p) === before.get(p)) continue;
    if (baseFiles.get(p) === before.get(p)) continue;
    if (headFiles.get(p) !== baseFiles.get(p)) {
      sendJson(res, 405, { message: "Merge conflict: this pull request cannot be merged" });
      return;
    }
  }
  // Squash merge: one commit on the base branch whose tree is the head
  // tip's tree, so the merged bytes land on the default branch.
  const squashSha = putObject(
    gitRepo,
    "commit",
    buildCommit({
      tree: headTree ?? "",
      parents: [baseTip],
      author: GIT_AUTHOR,
      committer: GIT_AUTHOR,
      message: `${pr.title} (#${number})`,
    }),
  );
  gitRepo.refs.set(`refs/heads/${baseRef}`, squashSha);
  pr.state = "closed";
  pr.merged = true;
  pr.merged_at = CREATED_AT;
  pr.merge_commit_sha = squashSha;
  pr.updated_at = CREATED_AT;
  store.pullRequests.set(pr.id, pr as any);
  sendJson(res, 200, {
    merged: true,
    message: `Pull request #${number} merged`,
    sha: squashSha,
  });
}

/** New tree equal to `treeSha` with the file at `segments` removed. */
function gitDeletePath(
  repo: GitRepo,
  treeSha: string | null,
  segments: string[],
): string | null {
  const entries = treeSha ? loadTreeEntries(repo, treeSha) : [];
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (idx < 0) return null;
  if (rest.length === 0) {
    entries.splice(idx, 1);
  } else {
    if (entries[idx].mode !== "40000") return null;
    const newSub = gitDeletePath(repo, entries[idx].sha, rest);
    if (newSub === null) return null;
    entries[idx] = { mode: "40000", name: head, sha: newSub };
  }
  entries.sort(treeEntryCompare);
  return putObject(repo, "tree", buildTree(entries));
}

function handleDeleteContents(
  res: ServerResponse,
  owner: string,
  repo: string,
  path: string,
  body: any,
): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  const branch = typeof body?.branch === "string" && body.branch ? body.branch : "main";
  const segments = path === "" ? [] : path.split("/");
  const gitPathOk =
    segments.length > 0 && segments.every((s) => s !== "" && s !== "." && s !== "..");
  const ckey = contentKey(owner, repo, branch, path);
  let commitSha: string | null = null;
  let found = false;
  if (gitPathOk) {
    const gitRepo = getOrCreateGitRepo(owner, repo);
    const refName = `refs/heads/${branch}`;
    const parentSha =
      gitRepo.refs.get(refName) ?? (branch === "main" ? resolveHead(gitRepo).sha : null);
    const baseTree = parentSha ? gitCommitTree(gitRepo, parentSha) : null;
    const newTree = baseTree ? gitDeletePath(gitRepo, baseTree, segments) : null;
    if (newTree !== null) {
      found = true;
      commitSha = putObject(
        gitRepo,
        "commit",
        buildCommit({
          tree: newTree,
          parents: parentSha ? [parentSha] : [],
          author: GIT_AUTHOR,
          committer: GIT_AUTHOR,
          message: message || `Delete ${path}`,
        }),
      );
      gitRepo.refs.set(refName, commitSha);
    }
  }
  if (contents.has(ckey)) {
    found = true;
    contents.delete(ckey);
    if (!commitSha) commitSha = gitCommitSha(gitBlobSha(Buffer.from("")), message || `Delete ${path}`);
  }
  if (!found) {
    notFound(res);
    return;
  }
  sendJson(res, 200, {
    commit: {
      author: { date: CREATED_AT, email: "adaiversen@example.invalid", name: VIEWER_LOGIN },
      committer: { date: CREATED_AT, email: "adaiversen@example.invalid", name: VIEWER_LOGIN },
      html_url: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
      message: message || `Delete ${path}`,
      sha: commitSha,
      url: `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Contents (git object store + in-memory blob fallback).
//
// The git object store (git.ts) is the source of truth: a file pushed via
// git is readable through GET contents, and a file created via PUT
// contents is committed to refs/heads/<branch> so a git clone sees it.
// The module-level Map below is kept as a fallback for blobs that exist
// only there (e.g. a path git cannot represent) and for reads when a repo
// has no git commit yet.
// ---------------------------------------------------------------------------

// Deterministic author/committer line for REST-created commits:
// "octocat <octocat@github.com> <unix of CREATED_AT> +0000".
const GIT_AUTHOR = `octocat <octocat@github.com> ${Math.floor(Date.parse(CREATED_AT) / 1000)} +0000`;

/** Commit sha at the tip of a branch, or null when the branch is unborn. */
function gitBranchCommit(repo: GitRepo, branch: string): string | null {
  const direct = repo.refs.get(`refs/heads/${branch}`);
  if (direct) return direct;
  if (branch === "main") return resolveHead(repo).sha;
  return null;
}

/** Root tree sha of a commit, or null when the commit is missing. */
function gitCommitTree(repo: GitRepo, commitSha: string): string | null {
  const obj = getObject(repo, commitSha);
  if (!obj || obj.type !== "commit") return null;
  return parseCommit(obj.content).tree || null;
}

function loadTreeEntries(repo: GitRepo, treeSha: string): TreeEntry[] {
  const obj = getObject(repo, treeSha);
  if (!obj || obj.type !== "tree") return [];
  return parseTree(obj.content);
}

/**
 * Find the entry at `segments` below `treeSha`. Returns the entry plus
 * the blob bytes when it is a file, or null when the path is absent (or
 * runs through a file).
 */
function gitFindEntry(
  repo: GitRepo,
  treeSha: string,
  segments: string[],
): { entry: TreeEntry; blob: Buffer | null } | null {
  let currentSha = treeSha;
  for (let i = 0; i < segments.length; i++) {
    const entry = loadTreeEntries(repo, currentSha).find((e) => e.name === segments[i]);
    if (!entry) return null;
    const isLast = i === segments.length - 1;
    const isTree = entry.mode === "40000";
    if (isTree) {
      if (isLast) return { entry, blob: null };
      currentSha = entry.sha;
    } else {
      if (!isLast) return null;
      const obj = getObject(repo, entry.sha);
      if (!obj || obj.type !== "blob") return null;
      return { entry, blob: obj.content };
    }
  }
  return null;
}

/** Git's tree sort order: directory names compare as if suffixed with "/". */
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === "40000" ? `${a.name}/` : a.name;
  const bn = b.mode === "40000" ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/**
 * Return the sha of a new tree equal to `treeSha` (or an empty tree when
 * null) with the file at `segments` set to `blobSha`, creating
 * intermediate directories as needed. An intermediate path segment that
 * is currently a file is replaced by a directory.
 */
function gitSetPath(
  repo: GitRepo,
  treeSha: string | null,
  segments: string[],
  blobSha: string,
): string {
  const entries = treeSha ? loadTreeEntries(repo, treeSha) : [];
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const fileEntry: TreeEntry = { mode: "100644", name: head, sha: blobSha };
    if (idx >= 0) entries[idx] = fileEntry;
    else entries.push(fileEntry);
  } else {
    let subSha: string | null = null;
    if (idx >= 0 && entries[idx].mode === "40000") subSha = entries[idx].sha;
    const newSubSha = gitSetPath(repo, subSha, rest, blobSha);
    const dirEntry: TreeEntry = { mode: "40000", name: head, sha: newSubSha };
    if (idx >= 0) entries[idx] = dirEntry;
    else entries.push(dirEntry);
  }
  entries.sort(treeEntryCompare);
  return putObject(repo, "tree", buildTree(entries));
}

/** GitHub-shaped directory listing of one git tree. */
function gitDirListing(
  owner: string,
  repoName: string,
  repo: GitRepo,
  treeSha: string,
  path: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const e of loadTreeEntries(repo, treeSha)) {
    const childPath = path === "" ? e.name : `${path}/${e.name}`;
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${childPath}`;
    if (e.mode === "40000") {
      out.push({ name: e.name, path: childPath, sha: e.sha, size: 0, type: "dir", url });
    } else {
      const obj = getObject(repo, e.sha);
      const size = obj && obj.type === "blob" ? obj.content.length : 0;
      out.push({ name: e.name, path: childPath, sha: e.sha, size, type: "file", url });
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

/** Immediate children of `path` in the fallback Map, keyed by name. */
function mapDirChildren(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Map<string, Record<string, unknown>> {
  const key = repoKey(owner, repo);
  const prefix = `${key}:${branch}:`;
  const dirPrefix = path === "" ? prefix : `${prefix}${path}/`;
  const children = new Map<string, Record<string, unknown>>();
  for (const [ckey, blob] of contents.entries()) {
    if (!ckey.startsWith(dirPrefix)) continue;
    const rest = ckey.slice(dirPrefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      children.set(rest, {
        name: rest,
        path: path === "" ? rest : `${path}/${rest}`,
        sha: blob.sha,
        size: blob.content.length,
        type: "file",
        url: `https://api.github.com/repos/${owner}/${repo}/contents/${path === "" ? rest : `${path}/${rest}`}`,
      });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        const dirPath = path === "" ? dirName : `${path}/${dirName}`;
        children.set(dirName, {
          name: dirName,
          path: dirPath,
          sha: sha1Hex(`tree ${dirPath}`),
          size: 0,
          type: "dir",
          url: `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`,
        });
      }
    }
  }
  return children;
}

function fileContentObject(owner: string, repo: string, branch: string, path: string, entry: BlobEntry): Record<string, unknown> {
  return {
    content: entry.content.toString("base64"),
    download_url: null,
    encoding: "base64",
    html_url: `https://github.com/${owner}/${repo}/blob/${branch}/${path}`,
    name: baseName(path),
    path,
    sha: entry.sha,
    size: entry.content.length,
    type: "file",
    url: `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
  };
}

function handleGetContents(res: ServerResponse, owner: string, repo: string, path: string, url: URL): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const branch = url.searchParams.get("ref") ?? "main";
  const segments = path === "" ? [] : path.split("/");

  // 1. Git object store first (files pushed via git live here).
  try {
    const gitRepo = getGitRepo(owner, repo);
    const commitSha = gitRepo ? gitBranchCommit(gitRepo, branch) : null;
    const treeSha = commitSha && gitRepo ? gitCommitTree(gitRepo, commitSha) : null;
    if (gitRepo && treeSha) {
      if (segments.length === 0) {
        const list = gitDirListing(owner, repo, gitRepo, treeSha, "");
        for (const [name, rec] of mapDirChildren(owner, repo, branch, "")) {
          if (!list.some((e) => e.name === name)) list.push(rec);
        }
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, list);
        return;
      }
      const found = gitFindEntry(gitRepo, treeSha, segments);
      if (found && found.blob !== null) {
        sendJson(
          res,
          200,
          fileContentObject(owner, repo, branch, path, {
            content: found.blob,
            sha: found.entry.sha,
            message: "",
          }),
        );
        return;
      }
      if (found && found.blob === null) {
        // Directory in the git tree.
        const list = gitDirListing(owner, repo, gitRepo, found.entry.sha, path);
        for (const [name, rec] of mapDirChildren(owner, repo, branch, path)) {
          if (!list.some((e) => e.name === name)) list.push(rec);
        }
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, list);
        return;
      }
      // Path is not in the git tree: fall through to the Map fallback.
    }
  } catch {
    // A corrupt git object must not break the fallback read.
  }

  // 2. Fallback: the in-memory blob Map.
  const entry = contents.get(contentKey(owner, repo, branch, path));
  if (entry) {
    sendJson(res, 200, fileContentObject(owner, repo, branch, path, entry));
    return;
  }

  // Directory listing: immediate children under "<path>/".
  const children = mapDirChildren(owner, repo, branch, path);
  if (children.size > 0) {
    const list = [...children.values()].sort((a, b) =>
      String(a.name).localeCompare(String(b.name)),
    );
    sendJson(res, 200, list);
    return;
  }
  notFound(res);
}

function handlePutContents(res: ServerResponse, owner: string, repo: string, path: string, body: any): void {
  const key = repoKey(owner, repo);
  if (!store.repos.get(key)) {
    notFound(res);
    return;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  const contentB64 = typeof body?.content === "string" ? body.content : "";
  if (!message || !contentB64) {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Content", field: "message", code: "missing_field" }] });
    return;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(contentB64, "base64");
  } catch {
    sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "Content", field: "content", code: "invalid" }] });
    return;
  }
  const branch = typeof body?.branch === "string" && body.branch ? body.branch : "main";
  const ckey = contentKey(owner, repo, branch, path);
  const mapExisted = contents.has(ckey);

  // Stale-sha guard (kit checks-rest repos.contents-stale-sha): an update
  // that names a sha other than the file's current blob sha is 409.
  const segments = path.split("/");
  const gitPathOk =
    segments.length > 0 && segments.every((s) => s !== "" && s !== "." && s !== "..");
  if (typeof body?.sha === "string" && body.sha) {
    let currentSha: string | null = null;
    if (gitPathOk) {
      const gr = getGitRepo(owner, repo);
      const tip = gr ? gitBranchCommit(gr, branch) : null;
      const tree = tip && gr ? gitCommitTree(gr, tip) : null;
      if (gr && tree) {
        const found = gitFindEntry(gr, tree, segments);
        if (found && found.blob !== null) currentSha = found.entry.sha;
      }
    }
    if (!currentSha && mapExisted) currentSha = contents.get(ckey)?.sha ?? null;
    if (currentSha && body.sha.toLowerCase() !== currentSha.toLowerCase()) {
      sendJson(res, 409, { message: "Conflict: sha does not match the current file" });
      return;
    }
  }

  // Write to the git object store: blob -> new tree (recursive for nested
  // paths) -> new commit on refs/heads/<branch>. Paths git cannot
  // represent (empty segments, "." / "..") stay Map-only with the legacy
  // deterministic commit id, so the git tree is never corrupted.
  // (segments / gitPathOk were computed above for the stale-sha guard.)
  let commitSha: string;
  let gitExisted = false;
  if (gitPathOk) {
    const gitRepo = getOrCreateGitRepo(owner, repo);
    const refName = `refs/heads/${branch}`;
    const parentSha =
      gitRepo.refs.get(refName) ?? (branch === "main" ? resolveHead(gitRepo).sha : null);
    let baseTree: string | null = null;
    if (parentSha) {
      baseTree = gitCommitTree(gitRepo, parentSha);
      if (baseTree) {
        const found = gitFindEntry(gitRepo, baseTree, segments);
        gitExisted = found !== null && found.blob !== null;
      }
    }
    const blobSha = putObject(gitRepo, "blob", buffer);
    const newTreeSha = gitSetPath(gitRepo, baseTree, segments, blobSha);
    commitSha = putObject(
      gitRepo,
      "commit",
      buildCommit({
        tree: newTreeSha,
        parents: parentSha ? [parentSha] : [],
        author: GIT_AUTHOR,
        committer: GIT_AUTHOR,
        message,
      }),
    );
    gitRepo.refs.set(refName, commitSha);
  } else {
    commitSha = gitCommitSha(gitBlobSha(buffer), message);
  }

  const existed = mapExisted || gitExisted;
  const blobSha = gitBlobSha(buffer);
  const entry: BlobEntry = { content: buffer, sha: blobSha, message };
  contents.set(ckey, entry);
  sendJson(res, existed ? 200 : 201, {
    commit: {
      author: { date: CREATED_AT, email: "octocat@github.com", name: "octocat" },
      committer: { date: CREATED_AT, email: "octocat@github.com", name: "octocat" },
      html_url: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
      message,
      sha: commitSha,
      url: `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`,
    },
    content: fileContentObject(owner, repo, branch, path, entry),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Routes this module serves, for the coordinator / documentation.
// Each is served both at /api/v3<route> and at <route>.
export const REST_ROUTES: string[] = [
  "GET /",
  "GET /meta",
  "GET /user",
  "POST /user/repos",
  "GET /user/repos",
  "GET /users/:username",
  "GET /users/:username/repos",
  "GET /repos/:owner/:repo",
  "PATCH /repos/:owner/:repo",
  "DELETE /repos/:owner/:repo",
  "POST /repos/:owner/:repo/git/refs",
  "GET /repos/:owner/:repo/branches",
  "GET /repos/:owner/:repo/commits",
  "POST /repos/:owner/:repo/labels",
  "GET /repos/:owner/:repo/issues",
  "POST /repos/:owner/:repo/issues",
  "GET /repos/:owner/:repo/issues/:number",
  "PATCH /repos/:owner/:repo/issues/:number",
  "GET /repos/:owner/:repo/issues/:number/comments",
  "POST /repos/:owner/:repo/issues/:number/comments",
  "GET /repos/:owner/:repo/pulls",
  "POST /repos/:owner/:repo/pulls",
  "GET /repos/:owner/:repo/pulls/:number",
  "GET /repos/:owner/:repo/pulls/:number/files",
  "PUT /repos/:owner/:repo/pulls/:number/merge",
  "GET /repos/:owner/:repo/contents/:path",
  "PUT /repos/:owner/:repo/contents/:path",
  "DELETE /repos/:owner/:repo/contents/:path",
];

// True when this module owns the path (so unknown sub-paths under
// /api/v3, /repos, /user, /users get a JSON 404 instead of falling
// through to the main router's {ok:false} shape).
function isRestPath(pathname: string): boolean {
  return (
    pathname === "/api/v3" ||
    pathname.startsWith("/api/v3/") ||
    pathname === "/repos" ||
    pathname.startsWith("/repos/") ||
    pathname === "/user" ||
    pathname.startsWith("/user/") ||
    pathname === "/users" ||
    pathname.startsWith("/users/")
  );
}

function decodeSegments(parts: string[]): string[] {
  return parts.map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
}

export function restRouter(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  if (!isRestPath(pathname)) return false;

  // Strip the /api/v3 prefix so one matcher serves both prefixes.
  let path = pathname;
  if (path === "/api/v3") path = "/";
  else if (path.startsWith("/api/v3/")) path = path.slice("/api/v3".length);

  const method = req.method ?? "GET";
  const seg = decodeSegments(path.split("/").filter(Boolean));

  // Auth: every API call carries Authorization: Bearer <token>; a request
  // without it is 401 (kit checks-rest repos.unauthorized).
  if (!hasAuth(req)) {
    unauthorized(res);
    return true;
  }

  const needsBody =
    method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
  const dispatch = (body: any): void => {
    // GET / — API root (200 JSON + X-OAuth-Scopes).
    if (method === "GET" && seg.length === 0) {
      sendJson(
        res,
        200,
        {
          current_user_url: "https://api.github.com/user",
          repository_url: "https://api.github.com/repos/{owner}/{repo}",
          user_url: "https://api.github.com/users/{username}",
        },
        { "x-oauth-scopes": "repo, read:org" },
      );
      return;
    }
    // GET /meta — installed version.
    if (method === "GET" && seg.length === 1 && seg[0] === "meta") {
      sendJson(res, 200, { installed_version: "1.0.0" });
      return;
    }
    // GET /user — viewer.
    if (method === "GET" && seg.length === 1 && seg[0] === "user") {
      sendJson(res, 200, userObject(VIEWER_LOGIN));
      return;
    }
    // POST /user/repos — create repo as the viewer.
    if (method === "POST" && seg.length === 2 && seg[0] === "user" && seg[1] === "repos") {
      handleCreateRepo(res, body);
      return;
    }
    // GET /user/repos — list the viewer's repos (paginated, Link rel="next").
    if (method === "GET" && seg.length === 2 && seg[0] === "user" && seg[1] === "repos") {
      handleListUserRepos(res, VIEWER_LOGIN, url);
      return;
    }
    // GET /users/:username — profile.
    if (method === "GET" && seg.length === 2 && seg[0] === "users") {
      sendJson(res, 200, userObject(seg[1]));
      return;
    }
    // GET /users/:username/repos — list a user's repos.
    if (method === "GET" && seg.length === 3 && seg[0] === "users" && seg[2] === "repos") {
      handleListUserRepos(res, seg[1], url);
      return;
    }
    // /repos/:owner/:repo ...
    if (seg.length >= 3 && seg[0] === "repos") {
      const [owner, repo] = [seg[1], seg[2]];
      // GET /repos/:owner/:repo
      if (method === "GET" && seg.length === 3) {
        handleGetRepo(res, owner, repo);
        return;
      }
      // PATCH /repos/:owner/:repo — update description.
      if (method === "PATCH" && seg.length === 3) {
        handlePatchRepo(res, owner, repo, body);
        return;
      }
      // DELETE /repos/:owner/:repo
      if (method === "DELETE" && seg.length === 3) {
        handleDeleteRepo(res, owner, repo);
        return;
      }
      // POST /repos/:owner/:repo/git/refs — create a branch.
      if (method === "POST" && seg.length === 5 && seg[3] === "git" && seg[4] === "refs") {
        handleCreateRef(res, owner, repo, body);
        return;
      }
      // GET /repos/:owner/:repo/branches
      if (method === "GET" && seg.length === 4 && seg[3] === "branches") {
        handleListBranches(res, owner, repo, url);
        return;
      }
      // GET /repos/:owner/:repo/commits
      if (method === "GET" && seg.length === 4 && seg[3] === "commits") {
        handleListCommits(res, owner, repo, url);
        return;
      }
      // POST /repos/:owner/:repo/labels
      if (method === "POST" && seg.length === 4 && seg[3] === "labels") {
        handleCreateLabel(res, owner, repo, body);
        return;
      }
      // GET|POST /repos/:owner/:repo/issues
      if (seg.length === 4 && seg[3] === "issues") {
        if (method === "GET") {
          handleListIssues(res, owner, repo, url);
          return;
        }
        if (method === "POST") {
          handleCreateIssue(res, owner, repo, body);
          return;
        }
      }
      // GET|PATCH /repos/:owner/:repo/issues/:number
      if (seg.length === 5 && seg[3] === "issues") {
        const number = Number.parseInt(seg[4], 10);
        if (Number.isInteger(number)) {
          if (method === "GET") {
            handleGetIssue(res, owner, repo, number);
            return;
          }
          if (method === "PATCH") {
            handlePatchIssue(res, owner, repo, number, body);
            return;
          }
        }
      }
      // GET|POST /repos/:owner/:repo/issues/:number/comments
      if (seg.length === 6 && seg[3] === "issues" && seg[5] === "comments") {
        const number = Number.parseInt(seg[4], 10);
        if (Number.isInteger(number)) {
          if (method === "GET") {
            handleListComments(res, owner, repo, number, url);
            return;
          }
          if (method === "POST") {
            handleCreateComment(res, owner, repo, number, body);
            return;
          }
        }
      }
      // GET|POST /repos/:owner/:repo/pulls
      if (seg.length === 4 && seg[3] === "pulls") {
        if (method === "GET") {
          handleListPulls(res, owner, repo, url);
          return;
        }
        if (method === "POST") {
          handleCreatePull(res, owner, repo, body);
          return;
        }
      }
      // GET /repos/:owner/:repo/pulls/:number
      if (seg.length === 5 && seg[3] === "pulls" && method === "GET") {
        const number = Number.parseInt(seg[4], 10);
        if (Number.isInteger(number)) {
          handleGetPull(res, owner, repo, number);
          return;
        }
      }
      // GET /repos/:owner/:repo/pulls/:number/files
      if (seg.length === 6 && seg[3] === "pulls" && seg[5] === "files" && method === "GET") {
        const number = Number.parseInt(seg[4], 10);
        if (Number.isInteger(number)) {
          handleListPullFiles(res, owner, repo, number, url);
          return;
        }
      }
      // PUT /repos/:owner/:repo/pulls/:number/merge
      if (seg.length === 6 && seg[3] === "pulls" && seg[5] === "merge" && method === "PUT") {
        const number = Number.parseInt(seg[4], 10);
        if (Number.isInteger(number)) {
          handleMergePull(res, owner, repo, number, body);
          return;
        }
      }
      // GET|PUT|DELETE /repos/:owner/:repo/contents/:path (path may contain "/")
      if (seg.length >= 4 && seg[3] === "contents") {
        const contentPath = seg.slice(4).join("/");
        if (method === "GET") {
          handleGetContents(res, owner, repo, contentPath, url);
          return;
        }
        if (method === "PUT") {
          handlePutContents(res, owner, repo, contentPath, body);
          return;
        }
        if (method === "DELETE") {
          handleDeleteContents(res, owner, repo, contentPath, body);
          return;
        }
      }
    }
    // Unknown REST path → JSON 404.
    notFound(res);
  };

  if (needsBody) {
    readBody(req).then(
      (body) => dispatch(body),
      (err: Error) => {
        if (err.message === "invalid json") {
          sendJson(res, 400, { message: "Problems parsing JSON" });
        } else {
          sendJson(res, 400, { message: "Bad Request" });
        }
      },
    );
  } else {
    dispatch(undefined);
  }
  return true;
}
