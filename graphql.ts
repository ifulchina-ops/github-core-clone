// GraphQL v4 (/api/graphql): a small executor for exactly the documents gh and
// github-mcp-server send — viewer, repository reads, issue/pull-request connections,
// __type introspection, the five mutations, node(id:) and batched operation bodies.
// Unknown fields answer HTTP 200 with an errors array naming the field; an unknown
// repository answers data.repository = null with no errors.

import { Store, VIEWER_LOGIN, gid, parseGid, type Issue, type Pull, type Repo } from './store.ts';

export interface GraphQLCtx {
  readonly store: Store;
  readonly body: unknown;
  readonly json: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface GqlField {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly selection: GqlField[] | null;
  readonly fragmentType: string | null;
}

interface GqlDocument {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly selection: GqlField[];
}

// ---------------------------------------------------------------- a tiny parser

class ParseError extends Error {}

function tokenize(text: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]$=@'.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const esc = text[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += text[j];
          j += 1;
        }
      }
      if (j >= text.length) throw new ParseError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j]!)) j += 1;
      tokens.push({ kind: 'number', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ kind: string; value: string }>;

  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  peek(): { kind: string; value: string } | undefined {
    return this.tokens[this.pos];
  }

  next(): { kind: string; value: string } {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(kind: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind) throw new ParseError(`expected ${kind}, got ${token.kind}`);
    return token;
  }

  parseDocument(): GqlDocument {
    let operation: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    // Variable definitions: ($owner: String!, ...) — skip them, values come from the body.
    if (this.peek()?.kind === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const token = this.next();
        if (token.kind === '(') depth += 1;
        else if (token.kind === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    const selection = this.parseSelection();
    return { operation, name, selection };
  }

  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek()?.kind !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): GqlField {
    if (this.peek()?.kind === 'spread') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        fragmentType = this.expect('name').value;
      }
      const selection = this.parseSelection();
      return { alias: null, name: '__fragment', args: {}, selection, fragmentType };
    }
    const first = this.expect('name').value;
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === ':') {
      this.next();
      alias = first;
      name = this.expect('name').value;
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.kind === '(') args = this.parseArguments();
    let selection: GqlField[] | null = null;
    if (this.peek()?.kind === '{') selection = this.parseSelection();
    return { alias, name, args, selection, fragmentType: null };
  }

  parseArguments(): Record<string, unknown> {
    this.expect('(');
    const args: Record<string, unknown> = {};
    while (this.peek()?.kind !== ')') {
      const key = this.expect('name').value;
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === '$') return { $var: this.expect('name').value };
    if (token.kind === '[') {
      const list: unknown[] = [];
      while (this.peek()?.kind !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.kind === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek()?.kind !== '}') {
        const key = this.expect('name').value;
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { $enum: token.value };
    }
    throw new ParseError(`unexpected value token ${token.kind}`);
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('$var' in (value as Record<string, unknown>)) {
      return variables[(value as { $var: string }).$var] ?? null;
    }
    if ('$enum' in (value as Record<string, unknown>)) {
      return (value as { $enum: string }).$enum;
    }
    if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = resolveVariables(entry, variables);
    return out;
  }
  return value;
}

function parseQuery(text: string): GqlDocument {
  return new Parser(tokenize(text)).parseDocument();
}

  // ---------------------------------------------------------------- the schema

  const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'];
  const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'url'];
  const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'];
  const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'];

  function typeFields(name: string): string[] | null {
    if (name === 'Issue') return ISSUE_FIELDS;
    if (name === 'PullRequest') return PULL_REQUEST_FIELDS;
    if (name === 'Repository') return REPOSITORY_FIELDS;
    return null;
  }

  // ---------------------------------------------------------------- values

  type Value =
    | { readonly __type: 'Query' }
    | { readonly __type: 'User'; readonly login: string }
    | { readonly __type: 'Ref'; readonly name: string }
    | { readonly __type: 'Repository'; readonly repo: Repo }
    | { readonly __type: 'Issue'; readonly repo: Repo; readonly issue: Issue }
    | { readonly __type: 'PullRequest'; readonly repo: Repo; readonly pull: Pull }
    | { readonly __type: 'IssueConnection'; readonly repo: Repo; readonly issues: Issue[]; readonly pageInfo: { hasNextPage: boolean; endCursor: string | null } }
    | { readonly __type: 'PullRequestConnection'; readonly repo: Repo; readonly pulls: Pull[] }
    | { readonly __type: 'FileConnection'; readonly paths: string[] }
    | { readonly __type: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null }
    | { readonly __type: 'Type'; readonly name: string }
    | { readonly __type: 'CommentEdge'; readonly id: string; readonly body: string }
    | { readonly __type: 'Comment'; readonly id: string; readonly body: string }
    | { readonly __type: 'CreateIssuePayload'; readonly issue: Issue; readonly repo: Repo }
    | { readonly __type: 'CloseIssuePayload'; readonly issue: Issue; readonly repo: Repo }
    | { readonly __type: 'CreatePullRequestPayload'; readonly pull: Pull; readonly repo: Repo }
    | { readonly __type: 'MergePullRequestPayload'; readonly pull: Pull; readonly repo: Repo }
    | { readonly __type: 'AddCommentPayload'; readonly id: string; readonly body: string };

  const TYPE_NAMES: Record<string, string> = {
    Query: 'Query',
    User: 'User',
    Ref: 'Ref',
    Repository: 'Repository',
    Issue: 'Issue',
    PullRequest: 'PullRequest',
    IssueConnection: 'IssueConnection',
    PullRequestConnection: 'PullRequestConnection',
    FileConnection: 'PullRequestFileConnection',
    PageInfo: 'PageInfo',
    Type: '__Type',
    CommentEdge: 'IssueCommentEdge',
    Comment: 'IssueComment',
    CreateIssuePayload: 'CreateIssuePayload',
    CloseIssuePayload: 'CloseIssuePayload',
    CreatePullRequestPayload: 'CreatePullRequestPayload',
    MergePullRequestPayload: 'MergePullRequestPayload',
    AddCommentPayload: 'AddCommentPayload',
  };

  function cursorFor(number: number): string {
    return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
  }

  function numberAfter(cursor: unknown): number | null {
    if (typeof cursor !== 'string' || cursor === '') return null;
    try {
      const text = Buffer.from(cursor, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(text);
      return match === null ? null : Number(match[1]);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- execution

  class Executor {
    private readonly errors: Array<{ message: string }> = [];
    private readonly store: Store;
    private readonly variables: Record<string, unknown>;

    constructor(store: Store, variables: Record<string, unknown>) {
      this.store = store;
      this.variables = variables;
    }

    run(document: GqlDocument): { data: Record<string, JsonValue | null>; errors: Array<{ message: string }> } {
      const data: Record<string, JsonValue | null> = {};
      const root: Value = { __type: 'Query' };
      for (const field of document.selection) {
        const value = this.resolve(root, field);
        data[field.alias ?? field.name] = value === undefined ? null : (value as JsonValue);
      }
      return { data, errors: this.errors };
    }

    private resolve(parent: Value, field: GqlField): unknown {
      if (field.name === '__fragment') {
        // An inline fragment applies when the parent is of the fragment's type.
        if (field.fragmentType !== null && TYPE_NAMES[parent.__type] !== field.fragmentType && parent.__type !== field.fragmentType) return undefined;
        const out: Record<string, unknown> = {};
        for (const sub of field.selection ?? []) {
          const value = this.resolve(parent, sub);
          if (value !== undefined) out[sub.alias ?? sub.name] = value;
        }
        return out;
      }
      const args = resolveArgs(field.args, this.variables);
      switch (parent.__type) {
        case 'Query':
          return this.resolveQuery(field, args);
        case 'Repository':
          return this.resolveRepository(parent.repo, field, args);
        case 'Issue':
          return this.resolveIssue(parent.issue, field, args);
        case 'PullRequest':
          return this.resolvePullRequest(parent, field, args);
        case 'IssueConnection':
          return this.resolveIssueConnection(parent, field);
        case 'PullRequestConnection':
          return this.resolvePullRequestConnection(parent, field);
        case 'FileConnection':
          if (field.name === 'nodes') return parent.paths.map((path) => ({ path }));
          return this.unknown(field, 'PullRequestFileConnection');
        case 'PageInfo':
          if (field.name === 'hasNextPage') return parent.hasNextPage;
          if (field.name === 'endCursor') return parent.endCursor;
          return this.unknown(field, 'PageInfo');
        case 'User':
          if (field.name === 'login') return parent.login;
          return this.unknown(field, 'User');
        case 'Ref':
          if (field.name === 'name') return parent.name;
          return this.unknown(field, 'Ref');
        case 'Type':
          return this.resolveType(parent.name, field);
        case 'CommentEdge':
          if (field.name === 'node') return this.select({ __type: 'Comment', id: parent.id, body: parent.body }, field);
          return this.unknown(field, 'IssueCommentEdge');
        case 'Comment':
          if (field.name === 'id') return parent.id;
          if (field.name === 'body') return parent.body;
          return this.unknown(field, 'IssueComment');
        case 'CreateIssuePayload':
          if (field.name === 'issue') return this.select({ __type: 'Issue', repo: parent.repo, issue: parent.issue }, field);
          return this.unknown(field, 'CreateIssuePayload');
        case 'CloseIssuePayload':
          if (field.name === 'issue') return this.select({ __type: 'Issue', repo: parent.repo, issue: parent.issue }, field);
          return this.unknown(field, 'CloseIssuePayload');
        case 'CreatePullRequestPayload':
        case 'MergePullRequestPayload':
          if (field.name === 'pullRequest') return this.select({ __type: 'PullRequest', repo: parent.repo, pull: parent.pull }, field);
          return this.unknown(field, parent.__type === 'CreatePullRequestPayload' ? 'CreatePullRequestPayload' : 'MergePullRequestPayload');
        case 'AddCommentPayload':
          if (field.name === 'commentEdge') return this.select({ __type: 'CommentEdge', id: parent.id, body: parent.body }, field);
          return this.unknown(field, 'AddCommentPayload');
        default:
          return this.unknown(field, 'Value');
      }
    }

    /** Resolve a value's sub-selection (or return the scalar itself). */
    private select(value: Value, field: GqlField): unknown {
      if (field.selection === null) return this.scalarOf(value);
      const out: Record<string, unknown> = {};
      for (const sub of field.selection) {
        const resolved = this.resolve(value, sub);
        if (resolved === undefined) continue;
        // An inline fragment's fields merge into the parent object; they are
        // not nested under the fragment itself.
        if (sub.name === '__fragment' && resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)) {
          Object.assign(out, resolved);
          continue;
        }
        out[sub.alias ?? sub.name] = resolved;
      }
      return out;
    }

    private scalarOf(value: Value): unknown {
      if (value.__type === 'User') return value.login;
      if (value.__type === 'Ref') return value.name;
      return null;
    }

    private unknown(field: GqlField, typeName: string): undefined {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return undefined;
    }

    private resolveQuery(field: GqlField, args: Record<string, unknown>): unknown {
      if (field.name === 'viewer') {
        return this.select({ __type: 'User', login: VIEWER_LOGIN }, field);
      }
      if (field.name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = this.store.getRepo(owner, name);
        if (repo === undefined) return null;
        return this.select({ __type: 'Repository', repo }, field);
      }
      if (field.name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const parsed = parseGid(id);
        if (parsed === null || parsed.kind !== 'Repository') return null;
        const [owner, name] = parsed.key.split('/');
        const repo = owner !== undefined && name !== undefined ? this.store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        return this.select({ __type: 'Repository', repo }, field);
      }
      if (field.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        return this.select({ __type: 'Type', name }, field);
      }
      if (field.name === '__schema') {
        return this.select({ __type: 'Type', name: '__Schema' }, field);
      }
      return this.resolveMutation(field, args);
    }

    /** The five mutations gh and github-mcp-server send, on the mutation root. */
    private resolveMutation(field: GqlField, args: Record<string, unknown>): unknown {
      const input = args.input !== null && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
      if (field.name === 'createIssue') {
        const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
        const repo = parsed?.kind === 'Repository' ? this.repoOfKey(parsed.key) : undefined;
        if (repo === undefined) {
          this.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = this.store.createIssue(repo, title, body, []);
        if ('error' in issue) {
          this.errors.push({ message: 'Could not create the issue.' });
          return null;
        }
        return this.select({ __type: 'CreateIssuePayload', issue, repo }, field);
      }
      if (field.name === 'closeIssue') {
        const parsed = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
        const found = parsed?.kind === 'Issue' ? this.issueOfKey(parsed.key) : undefined;
        if (found === undefined) {
          this.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          return null;
        }
        found.issue.state = 'closed';
        this.store.invalidateIssue(found.issue);
        return this.select({ __type: 'CloseIssuePayload', issue: found.issue, repo: found.repo }, field);
      }
      if (field.name === 'createPullRequest') {
        const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
        const repo = parsed?.kind === 'Repository' ? this.repoOfKey(parsed.key) : undefined;
        if (repo === undefined) {
          this.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          return null;
        }
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const pull = this.store.createPull(repo, head, base, title, body);
        if ('error' in pull) {
          this.errors.push({ message: 'Could not create the pull request.' });
          return null;
        }
        return this.select({ __type: 'CreatePullRequestPayload', pull, repo }, field);
      }
      if (field.name === 'mergePullRequest') {
        const parsed = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
        const found = parsed?.kind === 'PullRequest' ? this.pullOfKey(parsed.key) : undefined;
        if (found === undefined) {
          this.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
          return null;
        }
        const merged = this.store.mergePull(found.repo, found.pull);
        if ('error' in merged) {
          this.errors.push({ message: 'This pull request cannot be merged.' });
          return null;
        }
        return this.select({ __type: 'MergePullRequestPayload', pull: found.pull, repo: found.repo }, field);
      }
      if (field.name === 'addComment') {
        const parsed = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
        const found = parsed?.kind === 'Issue' ? this.issueOfKey(parsed.key) : undefined;
        if (found === undefined) {
          this.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          return null;
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = this.store.addComment(found.repo, found.issue, body);
        return this.select({ __type: 'AddCommentPayload', id: comment.gid, body: comment.body }, field);
      }
      return this.unknown(field, 'Query');
    }

    /** A repository from a global id's key ("owner/name"). */
    private repoOfKey(key: string): Repo | undefined {
      const slash = key.indexOf('/');
      if (slash < 0) return undefined;
      return this.store.getRepo(key.slice(0, slash), key.slice(slash + 1));
    }

    /** An issue from a global id's key ("owner/name#number"). */
    private issueOfKey(key: string): { repo: Repo; issue: Issue } | undefined {
      const hash = key.lastIndexOf('#');
      if (hash < 0) return undefined;
      const repo = this.repoOfKey(key.slice(0, hash));
      if (repo === undefined) return undefined;
      const issue = this.store.getIssue(repo, Number(key.slice(hash + 1)));
      return issue === undefined ? undefined : { repo, issue };
    }

    /** A pull request from a global id's key ("owner/name#number"). */
    private pullOfKey(key: string): { repo: Repo; pull: Pull } | undefined {
      const hash = key.lastIndexOf('#');
      if (hash < 0) return undefined;
      const repo = this.repoOfKey(key.slice(0, hash));
      if (repo === undefined) return undefined;
      const pull = this.store.getPull(repo, Number(key.slice(hash + 1)));
      return pull === undefined ? undefined : { repo, pull };
    }

    private resolveType(name: string, field: GqlField): unknown {
      if (field.name === 'name') return name;
      if (field.name === 'fields') {
        const names = typeFields(name);
        if (names === null) return null;
        return names.map((entry) => ({ name: entry }));
      }
      if (field.name === 'enumValues') {
        if (name === 'SearchType') return SEARCH_TYPE_VALUES.map((entry) => ({ name: entry }));
        return null;
      }
      return this.unknown(field, '__Type');
    }

    private resolveRepository(repo: Repo, field: GqlField, args: Record<string, unknown>): unknown {
      switch (field.name) {
        case 'id':
          return gid('Repository', `${repo.owner}/${repo.name}`);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return this.select({ __type: 'User', login: repo.owner }, field);
        case 'defaultBranchRef':
          return this.select({ __type: 'Ref', name: repo.defaultBranch }, field);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.isPrivate;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = this.store.getIssue(repo, number);
          if (issue === undefined) return null;
          return this.select({ __type: 'Issue', repo, issue }, field);
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const after = numberAfter(args.after);
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = args.orderBy !== null && typeof args.orderBy === 'object' ? (args.orderBy as Record<string, unknown>) : null;
          let issues = [...repo.issues];
          if (states !== null) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy?.direction === 'ASC' ? 'asc' : orderBy?.direction === 'DESC' ? 'desc' : 'asc';
          issues.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
          if (after !== null) {
            const index = issues.findIndex((issue) => issue.number === after);
            issues = index < 0 ? [] : issues.slice(index + 1);
          }
          const nodes = issues.slice(0, first);
          const hasNextPage = issues.length > first;
          const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : null;
          return this.select(
            { __type: 'IssueConnection', repo, issues: nodes, pageInfo: { hasNextPage, endCursor } },
            field,
          );
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
          return this.select({ __type: 'PullRequestConnection', repo, pulls }, field);
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = this.store.getPull(repo, number);
          if (pull === undefined) return null;
          return this.select({ __type: 'PullRequest', repo, pull }, field);
        }
        default:
          return this.unknown(field, 'Repository');
      }
    }

    private resolveIssue(issue: Issue, field: GqlField, _args: Record<string, unknown>): unknown {
      switch (field.name) {
        case 'id':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        default:
          return this.unknown(field, 'Issue');
      }
    }

    private resolvePullRequest(parent: { repo: Repo; pull: Pull }, field: GqlField, _args: Record<string, unknown>): unknown {
      const { repo, pull } = parent;
      switch (field.name) {
        case 'id':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return this.store.mergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files': {
          const paths = this.store.pullFiles(repo, pull).map((file) => file.filename);
          return this.select({ __type: 'FileConnection', paths }, field);
        }
        default:
          return this.unknown(field, 'PullRequest');
      }
    }

    private resolveIssueConnection(parent: { repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }, field: GqlField): unknown {
      if (field.name === 'nodes') {
        return parent.issues.map((issue) => this.select({ __type: 'Issue', repo: parent.repo, issue }, { ...field, selection: field.selection }));
      }
      if (field.name === 'pageInfo') {
        return this.select({ __type: 'PageInfo', hasNextPage: parent.pageInfo.hasNextPage, endCursor: parent.pageInfo.endCursor }, field);
      }
      if (field.name === 'totalCount') return parent.issues.length;
      return this.unknown(field, 'IssueConnection');
    }

    private resolvePullRequestConnection(parent: { repo: Repo; pulls: Pull[] }, field: GqlField): unknown {
      if (field.name === 'nodes') {
        return parent.pulls.map((pull) => this.select({ __type: 'PullRequest', repo: parent.repo, pull }, { ...field, selection: field.selection }));
      }
      if (field.name === 'totalCount') return parent.pulls.length;
      return this.unknown(field, 'PullRequestConnection');
    }
  }

  function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) out[key] = resolveVariables(value, variables);
    return out;
  }

  // ---------------------------------------------------------------- entry point

  /** Execute one operation document (already parsed) against the store. */
  function executeOperation(
    store: Store,
    query: string,
    variables: Record<string, unknown>,
  ): { data: Record<string, JsonValue | null>; errors?: Array<{ message: string }> } {
    let document: GqlDocument;
    try {
      document = parseQuery(query);
    } catch (err) {
      return { data: {}, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    const executor = new Executor(store, variables);
    const { data, errors } = executor.run(document);
    return errors.length > 0 ? { data, errors } : { data };
  }

  /** POST /api/graphql: one operation object, or an array of them (batched, in order). */
  export function handleGraphQL(ctx: GraphQLCtx): void {
    const body = ctx.body;
    if (Array.isArray(body)) {
      const results = body.map((entry) => {
        if (entry === null || typeof entry !== 'object') return { data: {}, errors: [{ message: 'Expected an operation object.' }] };
        const record = entry as Record<string, unknown>;
        const query = typeof record.query === 'string' ? record.query : '';
        const variables = record.variables !== null && typeof record.variables === 'object' ? (record.variables as Record<string, unknown>) : {};
        return executeOperation(ctx.store, query, variables);
      });
      ctx.json(200, results);
      return;
    }
    if (body === null || typeof body !== 'object') {
      ctx.json(200, { data: {}, errors: [{ message: 'Expected a GraphQL operation object.' }] });
      return;
    }
    const record = body as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = record.variables !== null && typeof record.variables === 'object' ? (record.variables as Record<string, unknown>) : {};
    ctx.json(200, executeOperation(ctx.store, query, variables));
  }
