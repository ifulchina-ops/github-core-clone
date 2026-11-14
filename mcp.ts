// MCP (/mcp): JSON-RPC 2.0 over Streamable HTTP, answering plain JSON. It speaks the
// 2026-07-28 revision (server/discover, every request declaring it in _meta) and the
// handshake era (initialize + notifications/initialized) for older clients. The six
// tools act on the same store as REST, so a repository created here reads back there.

import { Store, VIEWER_LOGIN, type Issue, type Repo } from './store.ts';

export interface McpCtx {
  readonly store: Store;
  /** The request body's raw text (a body that is not JSON is a -32700 parse error). */
  readonly bodyText: string;
  readonly json: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

const SERVER_INFO = { name: 'github-core-clone', version: '0.1.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One tool result: text blocks plus the structured value the suite reads first. */
function toolResult(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(text: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Split "owner/repo" or read owner + repo out of a tool's arguments. */
function repoRef(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = args.full_name.slice(0, slash);
      repo = args.full_name.slice(slash + 1);
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: true } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    const repo = store.createRepo(
      VIEWER_LOGIN,
      repoName,
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
    );
    if (repo === null) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    return toolResult(store.repoJson(repo));
  }

  const ref = repoRef(args);
  if (ref === null) return toolError('Missing required argument: owner or repo');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (name === 'get_repo') {
    if (repo === undefined) return toolError(`Repository ${ref.owner}/${ref.repo} not found`);
    return toolResult(store.repoJson(repo));
  }
  if (repo === undefined) return toolError(`Repository ${ref.owner}/${ref.repo} not found`);

  if (name === 'create_issue') {
    const title = String(args.title);
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = store.createIssue(repo, title, body, []);
    if ('error' in issue) return toolError(`Label '${issue.label}' does not exist`);
    return toolResult(store.issueJson(repo, issue));
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'all';
    const issues = store.listIssues(repo, { state });
    return toolResult(issues.map((issue: Issue) => store.issueJson(repo, issue)));
  }

  if (name === 'create_pull_request') {
    const title = String(args.title);
    const head = String(args.head);
    const base = String(args.base);
    const body = typeof args.body === 'string' ? args.body : '';
    const pull = store.createPull(repo, head, base, title, body);
    if ('error' in pull) return toolError(pull.error === 'unknown-branch' ? 'Unknown head or base branch' : 'A pull request for this head already exists');
    return toolResult(store.pullJson(repo, pull));
  }

  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pull = store.getPull(repo, number);
    if (pull === undefined) return toolError(`Pull request #${String(args.pull_number)} not found`);
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return toolError(merged.error === 'closed' ? 'Pull request is already closed' : 'This pull request cannot be merged: it has conflicts');
    return toolResult(store.pullJson(repo, pull));
  }

  return toolError(`Unknown tool: ${name}`);
}

export function handleMcp(ctx: McpCtx): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.bodyText);
  } catch {
    ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = parsed.id ?? null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  const answer = (result: unknown): void => {
    ctx.json(200, { jsonrpc: '2.0', id, result });
  };
  const fail = (code: number, messageText: string): void => {
    ctx.json(200, { jsonrpc: '2.0', id, error: { code, message: messageText } });
  };

  // A notification carries no id: it is acknowledged with 202 and an empty body.
  if (id === null) {
    if (method === 'notifications/initialized') {
      ctx.json(202, null);
      return;
    }
    ctx.json(202, null);
    return;
  }

  if (method === 'server/discover') {
    answer({
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    answer({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }

  if (method === 'ping') {
    answer({});
    return;
  }

  if (method === 'tools/list') {
    answer({ tools: toolsList() });
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (TOOLS.find((tool) => tool.name === toolName) === undefined) {
      fail(-32601, `Unknown tool: ${toolName}`);
      return;
    }
    answer(callTool(ctx.store, toolName, args));
    return;
  }

  fail(-32601, `Method not found: ${method}`);
}
