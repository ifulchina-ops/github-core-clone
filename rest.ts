// REST v3 (/api/v3): repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the one shared store. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry {message}; unknown routes are 404 JSON.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_ISO, Store, VIEWER_ID, VIEWER_LOGIN, type Repo } from './store.ts';
import { isObjectId, parseTree } from './gitobj.ts';

export interface RestCtx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly store: Store;
  readonly method: string;
  /** Path segments under /api/v3, percent-decoded. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body, or undefined when the request carried none. */
  readonly body: unknown;
  /** This request's X-GitHub-Request-Id value. */
  readonly requestId: string;
  /** Answer with a JSON body (status + extra headers). */
  readonly json: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function message(status: number, text: string): { status: number; body: { message: string } } {
  return { status, body: { message: text } };
}

function notFound(what: string): { status: number; body: { message: string } } {
  return message(404, `${what} not found`);
}

/** Slice a list into a page and build the GitHub-style Link header for the next page. */
function pageOf<T>(
  ctx: RestCtx,
  items: readonly T[],
): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'localhost';
    const path = (ctx.req.url ?? '').split('?')[0] ?? '';
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const nextUrl = `http://${host}${path}?${params.toString()}`;
    const lastPage = Math.ceil(items.length / perPage);
    params.set('page', String(lastPage));
    link = `<${nextUrl}>; rel="next", <http://${host}${path}?${params.toString()}>; rel="last"`;
  }
  return { page: [...slice], link };
}

function linkHeader(ctx: RestCtx, link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

function repoOf(ctx: RestCtx, owner: string, name: string): Repo | { status: number; body: { message: string } } {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return notFound('Repository');
  return repo;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function handleRest(ctx: RestCtx): boolean {
  const { method, segments } = ctx;
  const [first, second, third, ...rest] = segments;

  // GET /api/v3/ — the API root.
  if ((method === 'GET' && segments.length === 0) || (method === 'GET' && segments.length === 1 && segments[0] === '')) {
    ctx.json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (method === 'GET' && first === 'meta' && segments.length === 1) {
    ctx.json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user — the token owner's profile.
  if (method === 'GET' && first === 'user' && segments.length === 1) {
    ctx.json(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: 'VXNlcjoxMDAw',
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
      created_at: FIXED_ISO,
    });
    return true;
  }

  // POST /api/v3/user/repos — create a repository for the viewer.
  if (method === 'POST' && first === 'user' && second === 'repos' && segments.length === 2) {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      const err = message(422, 'name is required');
      ctx.json(err.status, err.body);
      return true;
    }
    const repo = ctx.store.createRepo(
      VIEWER_LOGIN,
      name,
      body.private === true,
      typeof body.description === 'string' ? body.description : '',
    );
    if (repo === null) {
      const err = message(422, 'Repository already exists');
      ctx.json(err.status, err.body);
      return true;
    }
    ctx.json(201, ctx.store.repoJson(repo));
    return true;
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (method === 'GET' && first === 'user' && second === 'repos' && segments.length === 2) {
    const repos = ctx.store.viewerRepos();
    const { page, link } = pageOf(ctx, repos.map((repo) => ctx.store.repoJson(repo)));
    ctx.json(200, page, linkHeader(ctx, link));
    return true;
  }

  if (first !== 'repos' || second === undefined || third === undefined) return false;
  const owner = decodeSegment(second);
  const repoName = decodeSegment(third);

  // GET /api/v3/repos/{owner}/{repo}
  if (method === 'GET' && segments.length === 3) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    ctx.json(200, ctx.store.repoJson(repo));
    return true;
  }

  // PATCH /api/v3/repos/{owner}/{repo}
  if (method === 'PATCH' && segments.length === 3) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const body = isRecord(ctx.body) ? ctx.body : {};
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    ctx.json(200, ctx.store.repoJson(repo));
    return true;
  }

  // DELETE /api/v3/repos/{owner}/{repo}
  if (method === 'DELETE' && segments.length === 3) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    ctx.store.deleteRepo(owner, repoName);
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }

  const sub = rest[0];
  const subRest = rest.slice(1);

  // POST /api/v3/repos/{owner}/{repo}/git/refs — create a branch ref.
  if (method === 'POST' && sub === 'git' && subRest[0] === 'refs' && segments.length === 5) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const body = isRecord(ctx.body) ? ctx.body : {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !isObjectId(sha) || ctx.store.getObject(repo, sha) === undefined) {
      const err = message(422, 'Invalid ref or sha');
      ctx.json(err.status, err.body);
      return true;
    }
    if (repo.refs.has(ref)) {
      const err = message(422, 'Reference already exists');
      ctx.json(err.status, err.body);
      return true;
    }
    repo.refs.set(ref, sha);
    ctx.json(201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}` });
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}
  if (method === 'GET' && sub === 'git' && subRest[0] === 'refs' && subRest[1] === 'heads' && segments.length >= 6) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const branch = subRest.slice(2).map(decodeSegment).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      const err = notFound('Reference');
      ctx.json(err.status, err.body);
      return true;
    }
    ctx.json(200, { ref: `refs/heads/${branch}`, object: { sha }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/heads/${branch}` });
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/branches
  if (method === 'GET' && sub === 'branches' && segments.length === 4) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const branches = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .sort()
      .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! }, protected: false }));
    ctx.json(200, branches);
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/branches/{branch}
  if (method === 'GET' && sub === 'branches' && segments.length >= 5) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const branch = subRest.map(decodeSegment).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      const err = notFound('Branch');
      ctx.json(err.status, err.body);
      return true;
    }
    ctx.json(200, { name: branch, commit: { sha }, protected: false });
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/commits
  if (method === 'GET' && sub === 'commits' && segments.length === 4) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const branch = ctx.query.get('sha') ?? undefined;
    const commits = ctx.store.listCommits(repo, branch).map((commit) => ({
      sha: commit.sha,
      commit: {
        message: commit.message,
        author: parseIdentity(commit.author),
        committer: parseIdentity(commit.committer),
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((sha) => ({ sha })),
      url: `/api/v3/repos/${owner}/${repoName}/commits/${commit.sha}`,
      html_url: `https://github.com/${owner}/${repoName}/commit/${commit.sha}`,
    }));
    const { page, link } = pageOf(ctx, commits);
    ctx.json(200, page, linkHeader(ctx, link));
    return true;
  }

  // Contents: PUT / GET / DELETE /repos/{owner}/{repo}/contents/{path...}
  if (sub === 'contents' && segments.length >= 5) {
    return handleContents(ctx, owner, repoName, subRest.map(decodeSegment).join('/'));
  }

  // POST /api/v3/repos/{owner}/{repo}/labels
  if (method === 'POST' && sub === 'labels' && segments.length === 4) {
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const body = isRecord(ctx.body) ? ctx.body : {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      const err = message(422, 'name is required');
      ctx.json(err.status, err.body);
      return true;
    }
    const label = ctx.store.createLabel(repo, name, typeof body.color === 'string' ? body.color : 'ededed');
    ctx.json(201, { name: label.name, color: label.color, description: '' });
    return true;
  }

  // Issues and pull requests live under /repos/{owner}/{repo}/issues and /pulls.
  if (sub === 'issues') return handleIssues(ctx, owner, repoName, subRest);
  if (sub === 'pulls') return handlePulls(ctx, owner, repoName, subRest);
  return false;
}

/** Split "Name <email> 1700000000 +0000" into GitHub's author object. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: FIXED_ISO };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

  // ---------------------------------------------------------------- contents

  function handleContents(ctx: RestCtx, owner: string, repoName: string, path: string): boolean {
    const { method } = ctx;
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const branch = ctx.query.get('ref') ?? repo.defaultBranch;
    const body = isRecord(ctx.body) ? ctx.body : {};

    if (method === 'PUT') {
      const content = typeof body.content === 'string' ? body.content : '';
      const commitMessage = typeof body.message === 'string' ? body.message : 'Update file';
      const putBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const existed = ctx.store.branchState(repo, putBranch).files.has(path);
      const result = ctx.store.putContent(repo, path, content, commitMessage, putBranch, sha);
      if ('error' in result) {
        const err = message(409, 'The file has changed since the sha you named');
        ctx.json(err.status, err.body);
        return true;
      }
      ctx.json(existed ? 200 : 201, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: Buffer.from(content, 'base64').length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha, message: commitMessage },
      });
      return true;
    }

    if (method === 'DELETE') {
      const deleteMessage = typeof body.message === 'string' ? body.message : 'Delete file';
      const deleteBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = ctx.store.deleteContent(repo, path, deleteMessage, deleteBranch, sha);
      if ('error' in result) {
        const err = result.error === 'not-found' ? notFound('File') : message(409, 'The file has changed since the sha you named');
        ctx.json(err.status, err.body);
        return true;
      }
      ctx.json(200, { commit: { sha: result.commitSha, message: deleteMessage } });
      return true;
    }

    if (method === 'GET') {
      const { files } = ctx.store.branchState(repo, branch);
      const file = files.get(path);
      if (file !== undefined) {
        const object = ctx.store.getObject(repo, file.oid);
        const data = object?.data ?? Buffer.alloc(0);
        ctx.json(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: data.toString('base64'),
          sha: file.oid,
        });
        return true;
      }
      // A directory: the tree at this path, or the repo root when the path is empty.
      const tip = ctx.store.refCommit(repo, `refs/heads/${branch}`);
      if (tip === undefined) {
        const err = notFound('File');
        ctx.json(err.status, err.body);
        return true;
      }
      let treeOid = ctx.store.treeOfCommit(repo, tip);
      let found = path === '';
      if (!found) {
        const segments = path.split('/');
        for (const segment of segments) {
          const tree = ctx.store.getObject(repo, treeOid);
          if (tree === undefined || tree.type !== 'tree') {
            treeOid = '';
            break;
          }
          const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
          if (entry === undefined || entry.mode !== '40000') {
            treeOid = '';
            break;
          }
          treeOid = entry.oid;
          found = true;
        }
        // The loop sets found=true on every step; a missing segment leaves treeOid ''.
        if (treeOid === '') found = false;
      }
      if (!found || treeOid === '') {
        const err = notFound('File');
        ctx.json(err.status, err.body);
        return true;
      }
      const tree = ctx.store.getObject(repo, treeOid);
      if (tree === undefined || tree.type !== 'tree') {
        const err = notFound('File');
        ctx.json(err.status, err.body);
        return true;
      }
      const entries = parseTree(tree.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (ctx.store.getObject(repo, entry.oid)?.data.length ?? 0),
      }));
      ctx.json(200, entries);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- issues

  function handleIssues(ctx: RestCtx, owner: string, repoName: string, segments: string[]): boolean {
    const { method } = ctx;
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const body = isRecord(ctx.body) ? ctx.body : {};

    // POST /repos/{owner}/{repo}/issues
    if (method === 'POST' && segments.length === 0) {
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels = rawLabels.map((label) => (typeof label === 'string' ? label : isRecord(label) && typeof label.name === 'string' ? label.name : '')).filter((name) => name !== '');
      const result = ctx.store.createIssue(repo, title, issueBody, labels);
      if ('error' in result) {
        const err = message(422, `Label '${result.label}' does not exist`);
        ctx.json(err.status, err.body);
        return true;
      }
      ctx.json(201, ctx.store.issueJson(repo, result));
      return true;
    }

    // GET /repos/{owner}/{repo}/issues
    if (method === 'GET' && segments.length === 0) {
      const issues = ctx.store.listIssues(repo, {
        state: ctx.query.get('state') ?? undefined,
        sort: ctx.query.get('sort') ?? undefined,
        direction: ctx.query.get('direction') ?? undefined,
      });
      const { page, link } = pageOf(ctx, issues.map((issue) => ctx.store.issueJson(repo, issue)));
      ctx.json(200, page, linkHeader(ctx, link));
      return true;
    }

    const number = Number.parseInt(segments[0] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) return false;
    const issue = ctx.store.getIssue(repo, number);
    if (issue === undefined) {
      const err = notFound('Issue');
      ctx.json(err.status, err.body);
      return true;
    }

    // GET /repos/{owner}/{repo}/issues/{n}
    if (method === 'GET' && segments.length === 1) {
      ctx.json(200, ctx.store.issueJson(repo, issue));
      return true;
    }

    // PATCH /repos/{owner}/{repo}/issues/{n}
    if (method === 'PATCH' && segments.length === 1) {
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      ctx.json(200, ctx.store.issueJson(repo, issue));
      return true;
    }

    // POST /repos/{owner}/{repo}/issues/{n}/comments
    if (method === 'POST' && segments.length === 2 && segments[1] === 'comments') {
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = ctx.store.addComment(repo, issue, commentBody);
      ctx.json(201, { id: comment.id, node_id: comment.gid, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_ISO });
      return true;
    }

    // GET /repos/{owner}/{repo}/issues/{n}/comments
    if (method === 'GET' && segments.length === 2 && segments[1] === 'comments') {
      ctx.json(200, issue.comments.map((comment) => ({ id: comment.id, node_id: comment.gid, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_ISO })));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- pull requests

  function handlePulls(ctx: RestCtx, owner: string, repoName: string, segments: string[]): boolean {
    const { method } = ctx;
    const repo = repoOf(ctx, owner, repoName);
    if (!('id' in repo)) {
      ctx.json(repo.status, repo.body);
      return true;
    }
    const body = isRecord(ctx.body) ? ctx.body : {};

    // POST /repos/{owner}/{repo}/pulls
    if (method === 'POST' && segments.length === 0) {
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const result = ctx.store.createPull(repo, head, base, title, pullBody);
      if ('error' in result) {
        const err = message(422, result.error === 'unknown-branch' ? 'Unknown head or base branch' : 'A pull request for this head already exists');
        ctx.json(err.status, err.body);
        return true;
      }
      ctx.json(201, ctx.store.pullJson(repo, result));
      return true;
    }

    // GET /repos/{owner}/{repo}/pulls
    if (method === 'GET' && segments.length === 0) {
      const pulls = ctx.store.listPulls(repo, ctx.query.get('state') ?? 'open');
      const { page, link } = pageOf(ctx, pulls.map((pull) => ctx.store.pullJson(repo, pull)));
      ctx.json(200, page, linkHeader(ctx, link));
      return true;
    }

    const number = Number.parseInt(segments[0] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) return false;
    const pull = ctx.store.getPull(repo, number);
    if (pull === undefined) {
      const err = notFound('Pull request');
      ctx.json(err.status, err.body);
      return true;
    }

    // GET /repos/{owner}/{repo}/pulls/{n}
    if (method === 'GET' && segments.length === 1) {
      ctx.json(200, ctx.store.pullJson(repo, pull));
      return true;
    }

    // GET /repos/{owner}/{repo}/pulls/{n}/files
    if (method === 'GET' && segments.length === 2 && segments[1] === 'files') {
      const files = ctx.store.pullFiles(repo, pull).map((file) => ({
        ...file,
        sha: ctx.store.treeFiles(repo, ctx.store.treeOfCommit(repo, pull.headSha)).get(file.filename)?.oid ?? '',
      }));
      ctx.json(200, files);
      return true;
    }

    // PUT /repos/{owner}/{repo}/pulls/{n}/merge
    if (method === 'PUT' && segments.length === 2 && segments[1] === 'merge') {
      const result = ctx.store.mergePull(repo, pull);
      if ('error' in result) {
        const err = result.error === 'closed'
          ? message(405, 'Pull request is already closed')
          : message(405, 'This pull request cannot be merged: it has conflicts');
        ctx.json(err.status, err.body);
        return true;
      }
      ctx.json(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    return false;
  }
