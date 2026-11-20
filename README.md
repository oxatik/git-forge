# git-forge

A standalone, GitHub-compatible git forge in one Node 22 process, built by an AI agent for
[make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01).
It serves the four surfaces a GitHub client exercises — git smart HTTP (v0 and v2 wire protocol with
its own SHA-1 object model, pack parsing and pack building, shallow fetch, receive-pack with
report-status), GitHub REST v3 (repositories, branches, commits, contents, issues, comments, labels,
pull requests, files, merges, with Link pagination), GitHub GraphQL v4 (the documents `gh` and
`github-mcp-server` send, with Relay-style connections and global ids) and Model Context Protocol
over streamable HTTP — all backed by its own in-memory store. No `git` binary, no package manager,
no outside service: only the Node standard library.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/oxatik/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/oxatik/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:crypto` and `node:zlib` and its own modules only, and the
trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer <token>`; the expected token is read from the
`MAKEFUN_SHOP_TOKEN` environment variable. `/healthz` is the boot probe and takes none.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server and router.
- `store.ts`: the in-memory store (users, orgs, repos, issues, pulls, refs) with a fixed epoch and
  a sequence clock, so runs are deterministic.
- `git-objects.ts`: SHA-1 object model — blob/tree/commit/tag codecs, loose and packed objects,
  pack parsing and pack building, pkt-line and sideband framing.
- `treeops.ts`: tree building and flattening, three-way tree merge, merge-base, tree diff.
- `git-http.ts`: the git smart-HTTP endpoints (upload-pack v0/v2 with ls-refs, shallow and filter
  fetch; receive-pack with report-status).
- `rest.ts`: the REST v3 routes.
- `graphql.ts`: the GraphQL parser and executor.
- `mcp.ts`: the MCP endpoint and its tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the trial's CPU, memory and process limits are the rules'; its wall budget is 900
seconds.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0r28m0ag&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
