# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dery1987/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dery1987/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge — one Node 22 process, no UI, no
outside service, no git binary — built for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

## What it serves

From a single process and its own in-memory store, on an ephemeral port
it registers with the suite:

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v2 and
  receive-pack v0 for clone, fetch and push, including shallow clones.
  The packfile, object store and ref handling are implemented from
  scratch on `node:zlib` and `node:crypto`.
- **REST v3 API** (`/api/v3`): repositories, branches, commits, contents,
  issues, comments, labels, pull requests, files and merges, with
  pagination (`Link: rel="next"`), `X-GitHub-Request-Id` on every reply
  and Bearer-token auth.
- **GraphQL v4** (`/api/graphql`): the documents `gh` and
  `github-mcp-server` send (viewer, repository, issues, pullRequests,
  createIssue, createPullRequest).
- **MCP** (`/mcp`): Streamable HTTP, tools `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`, acting on the same store as REST.

Writes on one surface read back on the others: a file committed through
`PUT /contents` is visible to `git clone`, and a repository created over
MCP reads back over REST as the same object.

## Run

Requires Node 22:

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port of its own (never 8080), registers
that port with the suite via `POST $MAKEFUN_ENV_URL/register` when
`MAKEFUN_ENV_URL` is set, polls `GET $MAKEFUN_ENV_URL/done` until the
suite finishes, then closes and exits 0. State is deterministic: fixed
timestamps and per-repo counters, so two runs on the same instance leave
the same state export byte for byte.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the router: git, REST, GraphQL and MCP.
- `git.ts` — git object store, packfiles and smart HTTP.
- `rest.ts` — the REST v3 API.
- `graphql.ts` — the GraphQL v4 API.
- `mcp.ts` — the MCP endpoint and tools.
- `store.ts` — the shared in-memory store.

## License

MIT — see [LICENSE](LICENSE).
