// The forge's store: every repository, git object, ref, issue, pull request, label and
// comment lives here, in memory, and every surface (git smart HTTP, REST v3, GraphQL v4,
// MCP) reads and writes the same objects, so a repository created over MCP reads back
// over REST with its ids unchanged. Nothing is persisted: a trial runs in one process.
//
// Determinism: commit timestamps are the fixed forge epoch and every id comes from a
// counter, so two runs of the same trial leave the same state.

import {
  FORGE_EPOCH_SEC,
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type CommitView,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_ISO = new Date(FORGE_EPOCH_SEC * 1000).toISOString();

/** An opaque Relay-style global id: base64url of "<Kind>:<key>", never the plain number. */
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id made by gid(), or null when it is not one. */
export function parseGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export interface Comment {
  readonly id: number;
  readonly gid: string;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  readonly comments: Comment[];
  /** Serialized REST body, built lazily and dropped by dropIssueBody on any mutation. */
  bodyBytes: Buffer | null;
}

export interface Pull {
  readonly id: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  /** Bumped by bump() on every git-state change (a new object or a ref write). */
  generation: number;
  /** Built git-wire answers (fetch packs, ls-refs, advertisements), dropped by bump(). */
  readonly wireCache: Map<string, Buffer>;
  /** Parsed commits and trees, keyed by oid. Objects are immutable, so a parse never goes stale. */
  readonly parsedCommits: Map<string, CommitView>;
  readonly parsedTrees: Map<string, TreeEntry[]>;
}

export interface FileEntry {
  readonly oid: string;
  readonly mode: string;
}

const FORGE_AUTHOR = `Forge <forge@local> ${FORGE_EPOCH_SEC} +0000`;

/** Count the lines of a blob the way a diff stat does (a trailing newline ends the last line). */
export function lineCount(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

export class Store {
  private readonly repos = new Map<string, Repo>();
  private repoSeq = 1;
  private seq = 1;

  private nextSeq(): number {
    return this.seq++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.repoSeq++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      generation: 0,
      wireCache: new Map(),
      parsedCommits: new Map(),
      parsedTrees: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  /**
   * Record that a repo's git state changed: advance its generation and throw away every
   * cached wire answer (fetch packs, ls-refs, advertisements). Every object or ref write
   * calls this, so a cached answer can never outlive the state it was built from.
   */
  bump(repo: Repo): void {
    repo.generation += 1;
    repo.wireCache.clear();
  }

  /** A commit's parsed headers, memoized per repo (commits are immutable). */
  commitOf(repo: Repo, oid: string): CommitView | undefined {
    const hit = repo.parsedCommits.get(oid);
    if (hit !== undefined) return hit;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    const view = parseCommit(object.data);
    repo.parsedCommits.set(oid, view);
    return view;
  }

  /** A tree's parsed entries, memoized per repo (trees are immutable). */
  entriesOf(repo: Repo, oid: string): TreeEntry[] | undefined {
    const hit = repo.parsedTrees.get(oid);
    if (hit !== undefined) return hit;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entries = parseTree(object.data);
    repo.parsedTrees.set(oid, entries);
    return entries;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------------- git objects

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      this.bump(repo);
    }
    return oid;
  }

  storeObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, object);
      this.bump(repo);
    }
    return oid;
  }

  /** The commit a ref points at, peeling an annotated tag to its commit. */
  refCommit(repo: Repo, ref: string): string | undefined {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    return this.peelToCommit(repo, oid);
  }

  /** Peel a tag object to the commit it names (or the oid itself when it already is one). */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 8; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** The commit a tag object ultimately names (for ls-refs peeling). */
  peelTag(repo: Repo, oid: string): string | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tag') return undefined;
    return this.peelToCommit(repo, parseTag(object.data).object);
  }

  /** All ancestors of a commit (or tag) with their generation distance, nearest first. */
  ancestors(repo: Repo, tip: string): Map<string, number> {
    const seen = new Map<string, number>();
    const start = this.peelToCommit(repo, tip);
    if (start === undefined) return seen;
    // Index-pointer queue: shift() on a long queue is O(n) per pop.
    const queue: Array<{ oid: string; depth: number }> = [{ oid: start, depth: 0 }];
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, depth } = queue[head]!;
      if (seen.has(oid)) continue;
      seen.set(oid, depth);
      const view = this.commitOf(repo, oid);
      if (view === undefined) continue;
      for (const parent of view.parents) {
        if (!seen.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
    return seen;
  }

  /**
   * Whether `ancestor` is `descendant` itself or one of its ancestors. A push's
   * fast-forward check is one hop (the new commit's parent is the old tip), so walk
   * straight down from the descendant and stop the moment the ancestor is found
   * instead of building the whole ancestor set, O(history) per push. Same answer as
   * ancestors(descendant).has(ancestor): the ancestor is compared as the raw oid, so
   * a tag oid never matches, and the descendant is peeled first, as ancestors() does.
   */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const start = this.peelToCommit(repo, descendant);
    if (start === undefined || start === ancestor) return start === ancestor;
    const seen = new Set<string>([start]);
    const stack: string[] = [start];
    while (stack.length > 0) {
      const view = this.commitOf(repo, stack.pop()!);
      if (view === undefined) continue;
      for (const parent of view.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    return false;
  }

  /** The nearest common ancestor of two tips (BFS from the second tip). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const aAncestors = this.ancestors(repo, a);
    if (aAncestors.size === 0) return undefined;
    const start = this.peelToCommit(repo, b);
    if (start === undefined) return undefined;
    const queue: string[] = [start];
    const seen = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head]!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const view = this.commitOf(repo, oid);
      if (view === undefined) continue;
      for (const parent of view.parents) queue.push(parent);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- trees and commits

  /** Flatten a tree object to path -> entry, recursing into subdirectories. */
  treeFiles(repo: Repo, treeOid: string): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.entriesOf(repo, oid);
      if (entries === undefined) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree for a flat path -> entry map, bottom-up. */
  buildTreeFromFiles(repo: Repo, files: Map<string, FileEntry>): string {
    const buildLevel = (prefix: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const dirs = new Map<string, Map<string, FileEntry>>();
      for (const [path, entry] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, entry);
        }
      }
      for (const [dir, sub] of [...dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const subPrefix = `${prefix}${dir}/`;
        const subFiles = new Map<string, FileEntry>();
        for (const [path, entry] of sub) subFiles.set(path, entry);
        entries.push({ mode: '40000', name: dir, oid: buildLevel(subPrefix) });
        void subFiles;
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildLevel('');
  }

  /** The tree a commit names, or the empty tree when the commit is unknown. */
  treeOfCommit(repo: Repo, commitOid: string): string {
    const view = this.commitOf(repo, commitOid);
    if (view === undefined) return this.putObject(repo, 'tree', buildTree([]));
    return view.tree;
  }

  /** Make a commit on a branch from a flat file map; returns the commit oid. */
  commitFiles(repo: Repo, branch: string, files: Map<string, FileEntry>, message: string): string {
    const treeOid = this.buildTreeFromFiles(repo, files);
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const parents = parent !== undefined && parent !== ZERO_OID ? [parent] : [];
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents, message, author: FORGE_AUTHOR, committer: FORGE_AUTHOR }),
    );
    repo.refs.set(ref, commitOid);
    this.bump(repo);
    return commitOid;
  }

  /** The commits reachable from a branch tip, newest first (pre-order, parents in order). */
  listCommits(repo: Repo, branch?: string): Array<{ sha: string; message: string; tree: string; parents: string[]; author: string; committer: string; timestamp: number }> {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = this.peelToCommit(repo, repo.refs.get(ref) ?? '');
    const out: Array<{ sha: string; message: string; tree: string; parents: string[]; author: string; committer: string; timestamp: number }> = [];
    if (tip === undefined) return out;
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitOf(repo, oid);
      if (view === undefined) continue;
      const stamp = (line: string): number => {
        const match = / (\d+) [+-]\d{4}$/.exec(line);
        return match !== null ? Number(match[1]) : FORGE_EPOCH_SEC;
      };
      out.push({ sha: oid, message: view.message, tree: view.tree, parents: view.parents, author: view.author, committer: view.committer, timestamp: stamp(view.author) });
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]!);
    }
    return out;
  }

  // ---------------------------------------------------------------- contents API

  /** The branch tip commit and its files, for a contents read or write. */
  branchState(repo: Repo, branch: string): { tip: string | undefined; files: Map<string, FileEntry> } {
    const tip = this.peelToCommit(repo, repo.refs.get(`refs/heads/${branch}`) ?? '');
    if (tip === undefined) return { tip: undefined, files: new Map() };
    return { tip, files: this.treeFiles(repo, this.treeOfCommit(repo, tip)) };
  }

  /**
   * PUT a file through the contents API. Returns the new blob and commit shas, or an
   * error: 'stale-sha' when the caller named a blob sha that is not the file's current one.
   */
  putContent(
    repo: Repo,
    path: string,
    contentBase64: string,
    message: string,
    branch: string,
    sha?: string,
  ): { contentSha: string; commitSha: string } | { error: 'stale-sha' } {
    const bytes = Buffer.from(contentBase64, 'base64');
    const { files } = this.branchState(repo, branch);
    const current = files.get(path);
    if (sha !== undefined) {
      if (current === undefined || current.oid.toLowerCase() !== sha.toLowerCase()) return { error: 'stale-sha' };
    }
    const blobOid = this.putObject(repo, 'blob', bytes);
    files.set(path, { oid: blobOid, mode: '100644' });
    const commitSha = this.commitFiles(repo, branch, files, message);
    return { contentSha: blobOid, commitSha };
  }

  /** DELETE a file through the contents API. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string,
    sha?: string,
  ): { commitSha: string } | { error: 'not-found' | 'stale-sha' } {
    const { files } = this.branchState(repo, branch);
    const current = files.get(path);
    if (current === undefined) return { error: 'not-found' };
    if (sha !== undefined && current.oid.toLowerCase() !== sha.toLowerCase()) return { error: 'stale-sha' };
    files.delete(path);
    return { commitSha: this.commitFiles(repo, branch, files, message) };
  }

  // ---------------------------------------------------------------- issues and labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: 'bad-label'; label: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: 'bad-label', label: name };
    }
    const number = ++repo.issueSeq;
    const issue: Issue = {
      id: gid('Issue', `${repo.owner}/${repo.name}#${number}`),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      comments: [],
      bodyBytes: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  /** Drop an issue's cached serialized body: call after any mutation of its fields. */
  dropIssueBody(issue: Issue): void {
    issue.bodyBytes = null;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    let list = [...repo.issues];
    const state = options.state ?? 'open';
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const id = ++repo.commentSeq;
    const comment: Comment = { id, gid: gid('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${id}`), body, createdSeq: this.nextSeq() };
    issue.comments.push(comment);
    this.dropIssueBody(issue); // the comment count in the serialized body changed
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: 'unknown-branch' | 'duplicate' } {
    const headTip = this.peelToCommit(repo, repo.refs.get(`refs/heads/${head}`) ?? '');
    const baseTip = this.peelToCommit(repo, repo.refs.get(`refs/heads/${base}`) ?? '');
    if (headTip === undefined || baseTip === undefined) return { error: 'unknown-branch' };
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) return { error: 'duplicate' };
    const number = ++repo.pullSeq;
    const pull: Pull = {
      id: gid('PullRequest', `${repo.owner}/${repo.name}#${number}`),
      number,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    if (state === 'all') return [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
    return repo.pulls.filter((pull) => pull.state === state).sort((a, b) => b.createdSeq - a.createdSeq);
  }

  /** The changed paths between a pull request's base and head trees, with line stats. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFiles = this.treeFiles(repo, this.treeOfCommit(repo, pull.baseSha));
    const headFiles = this.treeFiles(repo, this.treeOfCommit(repo, pull.headSha));
    const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of paths) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      if (base === undefined && head !== undefined) {
        const data = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
        const additions = lineCount(data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base !== undefined && head === undefined) {
        const data = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
        const deletions = lineCount(data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (base !== undefined && head !== undefined) {
        const oldData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
        const additions = lineCount(newData);
        const deletions = lineCount(oldData);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /**
   * The three-way merge of a pull request onto its base branch's current tip.
   * Returns the merged tree oid, or null when both sides changed the same path differently.
   */
  mergeTree(repo: Repo, pull: Pull): string | null {
    const baseTip = this.peelToCommit(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '');
    const headTip = this.peelToCommit(repo, repo.refs.get(`refs/heads/${pull.headRef}`) ?? '');
    if (baseTip === undefined || headTip === undefined) return null;
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    const baseFiles = mergeBase === undefined ? new Map<string, FileEntry>() : this.treeFiles(repo, this.treeOfCommit(repo, mergeBase));
    const headFiles = this.treeFiles(repo, this.treeOfCommit(repo, headTip));
    const targetFiles = this.treeFiles(repo, this.treeOfCommit(repo, baseTip));
    const merged = new Map<string, FileEntry>(targetFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = targetFiles.get(path);
      const same = (x: FileEntry | undefined, y: FileEntry | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) continue; // the head did not change it: keep the target's version
      if (same(t, b)) {
        // the target did not change it: take the head's version
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      if (same(h, t)) continue; // both sides changed it the same way
      return null; // both sides changed it differently: a conflict
    }
    return this.buildTreeFromFiles(repo, merged);
  }

  /** Whether a pull request merges cleanly right now. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    return this.mergeTree(repo, pull) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit with the merged tree,
   * the base tip as its parent. Returns the merge commit sha, or an error.
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 'conflict' | 'closed' } {
    if (pull.state !== 'open') return { error: 'closed' };
    const baseTip = this.peelToCommit(repo, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '');
    if (baseTip === undefined) return { error: 'conflict' };
    const treeOid = this.mergeTree(repo, pull);
    if (treeOid === null) return { error: 'conflict' };
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const sha = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents: [baseTip], message, author: FORGE_AUTHOR, committer: FORGE_AUTHOR }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    this.bump(repo);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = sha;
    return { sha };
  }

  // ---------------------------------------------------------------- REST shapes

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: gid('Repository', `${repo.owner}/${repo.name}`),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: '' };
      }),
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      comments: issue.comments.length,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  /**
   * The issue's serialized REST body, memoized on the issue. The bytes are exactly
   * JSON.stringify(issueJson(repo, issue)); every mutation path (REST PATCH, GraphQL
   * closeIssue, addComment) drops the cache through dropIssueBody, and label colors are
   * fixed at creation, so the cached bytes can never be stale. Sending the cached
   * Buffer also skips the per-request UTF-8 re-encode of res.end(string).
   */
  issueBodyBytes(repo: Repo, issue: Issue): Buffer {
    const hit = issue.bodyBytes;
    if (hit !== null) return hit;
    const body = Buffer.from(JSON.stringify(this.issueJson(repo, issue)), 'utf8');
    issue.bodyBytes = body;
    return body;
  }

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    // head/base shas are the tips at creation time: the suite asserts them against the
    // branch tips as they stood when the pull request opened.
    const headTip = pull.headSha;
    const baseTip = pull.baseSha;
    return {
      id: pull.id,
      node_id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: headTip, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
      base: { ref: pull.baseRef, sha: baseTip, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }
}

export { ZERO_OID, isObjectId };
