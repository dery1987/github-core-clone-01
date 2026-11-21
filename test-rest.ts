// Small smoke test for rest.ts (REST v3 only).
// Run: node --experimental-strip-types test-rest.ts
// Spins up an ephemeral server wired to restRouter, then exercises:
// create repo -> create issue -> list issues -> get issue -> create PR ->
// get contents (404, then PUT, then GET + dir listing) -> users -> 404s -> delete.
import { createServer } from "node:http";
import { restRouter, resetRestState } from "./rest.ts";

resetRestState();

const server = createServer((req, res) => {
  if (!restRouter(req, res)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  }
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, () => {
    const addr = server.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  });
});
const base = `http://127.0.0.1:${port}`;

let passed = 0;
let failed = 0;

async function check(name: string, cond: boolean, detail = ""): Promise<void> {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    method,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body (204) */
  }
  return { res, json, text };
}

// 1. Create repo via /api/v3 prefix.
let r = await call("POST", "/api/v3/user/repos", { name: "hello", description: "test repo", private: false });
await check("POST /api/v3/user/repos -> 201", r.res.status === 201, `got ${r.res.status} ${r.text}`);
await check("repo has full_name adaiversen/hello", r.json?.full_name === "adaiversen/hello", JSON.stringify(r.json));
await check("repo default_branch main", r.json?.default_branch === "main", JSON.stringify(r.json));
await check("repo created_at deterministic", r.json?.created_at === "2026-01-01T00:00:00Z", JSON.stringify(r.json));
await check("repo id is integer 1", r.json?.id === 1, JSON.stringify(r.json));

// 2. Get repo via ROOT path (no /api/v3).
r = await call("GET", "/repos/adaiversen/hello");
await check("GET /repos/adaiversen/hello -> 200", r.res.status === 200, `got ${r.res.status}`);
await check("GET repo name hello", r.json?.name === "hello", JSON.stringify(r.json));

// 3. Create issue #1 (root path).
r = await call("POST", "/repos/adaiversen/hello/issues", { title: "First bug", body: "it broke" });
await check("POST issue -> 201", r.res.status === 201, `got ${r.res.status} ${r.text}`);
await check("issue number 1", r.json?.number === 1, JSON.stringify(r.json));
await check("issue state open", r.json?.state === "open", JSON.stringify(r.json));

// 4. Create issue #2, then list with ?state=open (prefix path).
r = await call("POST", "/api/v3/repos/adaiversen/hello/issues", { title: "Second bug" });
await check("POST issue #2 -> 201 number 2", r.res.status === 201 && r.json?.number === 2, `got ${r.res.status} ${r.text}`);
r = await call("GET", "/api/v3/repos/adaiversen/hello/issues?state=open&per_page=10&page=1");
await check("GET issues list -> 200 len 2", r.res.status === 200 && Array.isArray(r.json) && r.json.length === 2, `got ${r.res.status} ${r.text}`);
r = await call("GET", "/repos/adaiversen/hello/issues?state=closed");
await check("GET issues state=closed -> empty", r.res.status === 200 && Array.isArray(r.json) && r.json.length === 0, `got ${r.res.status} ${r.text}`);

// 5. Get single issue.
r = await call("GET", "/repos/adaiversen/hello/issues/1");
await check("GET issue 1 -> 200 title First bug", r.res.status === 200 && r.json?.title === "First bug", `got ${r.res.status} ${r.text}`);

// 6. PATCH issue -> close it.
r = await call("PATCH", "/repos/adaiversen/hello/issues/1", { state: "closed" });
await check("PATCH issue -> 200 state closed", r.res.status === 200 && r.json?.state === "closed", `got ${r.res.status} ${r.text}`);

// 7. Create PR #1.
r = await call("POST", "/repos/adaiversen/hello/pulls", { title: "Add feature", head: "feature", base: "main", body: "please merge" });
await check("POST pull -> 201 number 1", r.res.status === 201 && r.json?.number === 1, `got ${r.res.status} ${r.text}`);
await check("PR head/base refs", r.json?.head?.ref === "feature" && r.json?.base?.ref === "main", JSON.stringify(r.json));
await check("PR merged false", r.json?.merged === false, JSON.stringify(r.json));

// 8. Get PR + list PRs.
r = await call("GET", "/api/v3/repos/adaiversen/hello/pulls/1");
await check("GET pull 1 -> 200", r.res.status === 200 && r.json?.number === 1, `got ${r.res.status} ${r.text}`);
r = await call("GET", "/repos/adaiversen/hello/pulls");
await check("GET pulls list -> len 1", r.res.status === 200 && Array.isArray(r.json) && r.json.length === 1, `got ${r.res.status} ${r.text}`);

// 9. Contents: missing file -> 404 (nothing invented).
r = await call("GET", "/repos/adaiversen/hello/contents/README.md");
await check("GET contents missing -> 404 Not Found", r.res.status === 404 && r.json?.message === "Not Found", `got ${r.res.status} ${r.text}`);

// 10. PUT contents -> 201, then GET reads it back.
const helloB64 = Buffer.from("hello world\n", "utf8").toString("base64");
r = await call("PUT", "/api/v3/repos/adaiversen/hello/contents/README.md", { message: "add readme", content: helloB64 });
await check("PUT contents -> 201", r.res.status === 201, `got ${r.res.status} ${r.text}`);
await check("PUT returns commit sha", typeof r.json?.commit?.sha === "string" && r.json.commit.sha.length === 40, JSON.stringify(r.json));
r = await call("GET", "/repos/adaiversen/hello/contents/README.md");
await check("GET contents after PUT -> 200 file", r.res.status === 200 && r.json?.type === "file", `got ${r.res.status} ${r.text}`);
await check("GET contents base64 round-trip", Buffer.from(r.json?.content ?? "", "base64").toString("utf8") === "hello world\n", JSON.stringify(r.json));
await check("GET contents encoding base64", r.json?.encoding === "base64", JSON.stringify(r.json));

// 11. PUT again -> 200 (update), dir listing at root.
r = await call("PUT", "/repos/adaiversen/hello/contents/README.md", { message: "update readme", content: helloB64 });
await check("PUT existing contents -> 200", r.res.status === 200, `got ${r.res.status} ${r.text}`);
r = await call("GET", "/repos/adaiversen/hello/contents");
await check("GET contents root -> array with README.md", r.res.status === 200 && Array.isArray(r.json) && r.json.some((e: any) => e.name === "README.md" && e.type === "file"), `got ${r.res.status} ${r.text}`);

// 12. Users.
r = await call("GET", "/api/v3/user");
await check("GET /user -> adaiversen", r.res.status === 200 && r.json?.login === "adaiversen", `got ${r.res.status} ${r.text}`);
r = await call("GET", "/users/adaiversen");
await check("GET /users/adaiversen -> 200", r.res.status === 200 && r.json?.login === "adaiversen", `got ${r.res.status} ${r.text}`);
r = await call("GET", "/users/adaiversen/repos");
await check("GET /users/adaiversen/repos -> len 1", r.res.status === 200 && Array.isArray(r.json) && r.json.length === 1, `got ${r.res.status} ${r.text}`);

// 13. 404s.
r = await call("GET", "/repos/adaiversen/nope");
await check("GET missing repo -> 404 Not Found", r.res.status === 404 && r.json?.message === "Not Found", `got ${r.res.status} ${r.text}`);
r = await call("GET", "/api/v3/unknown/thing");
await check("GET unknown /api/v3 path -> 404 Not Found", r.res.status === 404 && r.json?.message === "Not Found", `got ${r.res.status} ${r.text}`);
r = await call("GET", "/repos/adaiversen/hello/issues/99");
await check("GET missing issue -> 404", r.res.status === 404, `got ${r.res.status} ${r.text}`);

// 14. DELETE repo -> 204, then gone.
r = await call("DELETE", "/repos/adaiversen/hello");
await check("DELETE repo -> 204", r.res.status === 204, `got ${r.res.status} ${r.text}`);
r = await call("GET", "/repos/adaiversen/hello");
await check("GET repo after DELETE -> 404", r.res.status === 404, `got ${r.res.status} ${r.text}`);

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
process.exit(failed === 0 ? 0 : 1);
