# github-core-clone

A standalone GitHub-compatible git forge in one Node process — no git binary, no
database. One in-memory store serves all four surfaces:

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v2 (ls-refs, fetch with
  shallow/deepen, ACK/NAK, sideband packs) and v0, receive-pack v0 with
  fast-forward-only pushes and per-ref `ok`/`ng` report lines. Plain-object packs
  on the wire; OFS/REF delta packs are read back.
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues, comments and pull requests, with Link pagination, `X-GitHub-Request-Id`
  on every reply, JSON errors (`{message}`), 409 on a stale content sha, 422 on
  an unknown label, 405 on a conflicted merge.
- **GraphQL v4** (`/api/graphql`): viewer, repository reads, issue/pull-request
  connections with cursor pagination, `__type` introspection, the five mutations
  (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment),
  `node(id:)` and batched operation bodies. Unknown fields answer HTTP 200 with
  an errors array; an unknown repository answers `data.repository: null`.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the `initialize` handshake era as a fallback. Six
  tools: create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request.

## Running

```sh
MAKEFUN_SHOP_TOKEN=shpat_… node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
and polls `$MAKEFUN_ENV_URL/done` until the harness says the run is over. The
bearer token is the viewer: the server answers as `adaiversen` for it, and
repositories under any other owner answer 404.

## Layout

- `main.ts` — process lifecycle (bind, register, wait for done).
- `app.ts` — HTTP entry point: auth, JSON parsing, routing.
- `store.ts` — the shared in-memory store (repos, issues, pulls, git objects).
- `gitobj.ts` — git object model and packfile codec (write/read, delta apply).
- `gitproto.ts` — pkt-lines, sideband, v0/v2 advertisements, fetch and push.
- `rest.ts` — the REST v3 router. `graphql.ts` — parser + executor.
  `mcp.ts` — JSON-RPC dispatcher and the six tools.
