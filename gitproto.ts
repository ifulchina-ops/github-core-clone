// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack and v0
// receive-pack, spoken against the store with no git binary. Packs are written with
// plain objects only (no deltas): a client that reads them never needs a delta base.
// Every ref update is fast-forward-only, reported per ref with report-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  isObjectId,
  parseTag,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { Store, VIEWER_LOGIN, type Repo } from './store.ts';

const MAX_PKT_LINE = 65520;
/** The largest data chunk one sideband pkt-line may carry (band byte + data). */
const SIDEBAND_CHUNK = 65000;
/** The largest wire answer worth keeping (a huge fetch's pack is rebuilt, not cached). */
const WIRE_CACHE_MAX_BYTES = 512 * 1024;
/** The most cached answers a repo keeps; the map is cleared when it grows past this. */
const WIRE_CACHE_MAX_ENTRIES = 64;

/**
 * A cached git-wire answer for a repo, or undefined. The cache lives on the repo and
 * Store.bump() clears it on every object or ref write, so a cached answer can never
 * outlive the state it was built from; the key only has to name the request. Fetch
 * answers are deterministic for (repo state, wants, haves, shallow, depth), so a
 * repeated identical fetch — fifty concurrent clones of one tip — is one pack build.
 */
function wireHit(repo: Repo, key: string): Buffer | undefined {
  return repo.wireCache.get(key);
}

function wireKeep(repo: Repo, key: string, body: Buffer): Buffer {
  if (body.length <= WIRE_CACHE_MAX_BYTES) {
    if (repo.wireCache.size >= WIRE_CACHE_MAX_ENTRIES) repo.wireCache.clear();
    repo.wireCache.set(key, body);
  }
  return body;
}

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Packet {
  readonly kind: PacketKind;
  readonly payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/**
 * Parse a pkt-line stream. Returns the packets and the offset where the framed part
 * ends (the byte after the last complete packet): a receive-pack body keeps its pack
 * as raw bytes after the command list's flush.
 */
export function parsePktLines(body: Buffer): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || length > MAX_PKT_LINE) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    }
    if (offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== body.length) throw new Error('trailing bytes after the pkt-line stream');
  return { packets, end: offset };
}

/** The packets' data payloads as text lines (without the trailing newline). */
export function packetLines(packets: readonly Packet[]): string[] {
  return packets
    .filter((packet) => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
}

/** Split sideband band-1 data into pkt-lines (each at most MAX_PKT_LINE raw bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------- ref listing

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

/** Every ref of a repository, HEAD first, then heads, then tags, each sorted. */
function listRefs(store: Store, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTip = store.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) lines.push({ oid: headTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const peeled = store.peelTag(repo, oid);
      if (peeled !== undefined) lines.push({ ...entry, peeled });
      else lines.push(entry);
    } else {
      lines.push(entry);
    }
  }
  return lines;
}

const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want';
const RECEIVE_V0_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** The v0 ref advertisement: preamble, flush, then one line per ref (caps on the first). */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', store: Store, repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(store, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = refs[0]!;
    parts.push(pktLine(`${first.oid} ${first.name}\0${caps}\n`));
    for (const ref of refs.slice(1)) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
    // A peeled line for the first ref (HEAD has none; a first tag would need one here).
    if (first.peeled !== undefined) parts.push(pktLine(`${first.peeled} ${first.name}^{}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: `version 2` and one capability per line. Built once — it never changes. */
const V2_ADS: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=github-core-clone/0.1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  pktFlush(),
]);

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

/** Every object reachable from a commit: the commit, its trees and blobs, tags peeled. */
function reachableObjects(store: Store, repo: Repo, tip: string): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visitCommit = (oid: string): void => {
    const commit = store.getObject(repo, oid);
    if (commit === undefined || commit.type !== 'commit' || out.has(oid)) return;
    out.set(oid, commit);
    const view = store.commitOf(repo, oid);
    if (view === undefined) return;
    visitTree(view.tree);
    for (const parent of view.parents) visitCommit(parent);
  };
  const visitTree = (oid: string): void => {
    const tree = store.getObject(repo, oid);
    if (tree === undefined || tree.type !== 'tree' || out.has(oid)) return;
    out.set(oid, tree);
    const entries = store.entriesOf(repo, oid);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else {
        const blob = store.getObject(repo, entry.oid);
        if (blob !== undefined) out.set(entry.oid, blob);
      }
    }
  };
  const visitTag = (oid: string): void => {
    const tag = store.getObject(repo, oid);
    if (tag === undefined || tag.type !== 'tag' || out.has(oid)) return;
    out.set(oid, tag);
    const target = parseTag(tag.data).object;
    const targetObject = store.getObject(repo, target);
    if (targetObject?.type === 'commit') visitCommit(target);
    else if (targetObject?.type === 'tag') visitTag(target);
  };
  const root = store.getObject(repo, tip);
  if (root?.type === 'tag') visitTag(tip);
  else if (root?.type === 'commit') visitCommit(tip);
  return out;
}

/** One commit and its own tree and blobs — no parents. A shallow fetch sends only
 * the commits inside the depth limit, each with its own tree; the parents of a
 * boundary commit are never part of its own objects. */
function commitOwnObjects(store: Store, repo: Repo, oid: string): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const commit = store.getObject(repo, oid);
  if (commit === undefined || commit.type !== 'commit') return out;
  out.set(oid, commit);
  const visitTree = (treeOid: string): void => {
    const tree = store.getObject(repo, treeOid);
    if (tree === undefined || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    const entries = store.entriesOf(repo, treeOid);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else {
        const blob = store.getObject(repo, entry.oid);
        if (blob !== undefined) out.set(entry.oid, blob);
      }
    }
  };
  const view = store.commitOf(repo, oid);
  if (view !== undefined) visitTree(view.tree);
  return out;
}

/**
 * Work out what a fetch sends: the objects reachable from the wants that the client
 * does not already hold, the shallow boundary commits, and the acknowledgments.
 * `shallowBoundaries` are the client's current shallow tips: their ancestors are not held.
 */
function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);
  // Objects the client already holds: the closure of its haves, not expanding past
  // a shallow boundary (its ancestors are not held).
  const held = new Map<string, GitObject>();
  const heldQueue: string[] = [...haves];
  const heldSeen = new Set<string>();
  for (let head = 0; head < heldQueue.length; head += 1) {
    const oid = heldQueue[head]!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = store.getObject(repo, oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      held.set(oid, object);
      if (shallowSet.has(oid)) continue; // a shallow tip: its parents are not held
      const view = store.commitOf(repo, oid);
      if (view === undefined) continue;
      for (const parent of view.parents) heldQueue.push(parent);
      for (const [, entry] of store.treeFiles(repo, view.tree)) {
        const blob = store.getObject(repo, entry.oid);
        if (blob !== undefined) held.set(entry.oid, blob);
      }
      // Trees themselves: walk them so their oids count as held too.
      const walkTree = (treeOid: string): void => {
        const tree = store.getObject(repo, treeOid);
        if (tree === undefined || tree.type !== 'tree' || held.has(treeOid)) return;
        held.set(treeOid, tree);
        const entries = store.entriesOf(repo, treeOid);
        if (entries === undefined) return;
        for (const entry of entries) {
          if (entry.mode === '40000') walkTree(entry.oid);
        }
      };
      walkTree(view.tree);
    } else if (object.type === 'tag') {
      held.set(oid, object);
      heldQueue.push(parseTag(object.data).object);
    }
  }

  // Commits to include, with their generation distance from the wants.
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const commit = store.peelToCommit(repo, want);
    if (commit !== undefined) queue.push({ oid: commit, depth: 0 });
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, depth: d } = queue[head]!;
    if (included.has(oid)) continue;
    if (depth !== null && d >= depth) continue;
    included.set(oid, d);
    const view = store.commitOf(repo, oid);
    if (view === undefined) continue;
    for (const parent of view.parents) queue.push({ oid: parent, depth: d + 1 });
  }

  // Boundary commits: included ones with a parent outside the included set.
  const shallow: string[] = [];
  for (const [oid] of included) {
    const view = store.commitOf(repo, oid);
    if (view === undefined) continue;
    if (view.parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  // Previously-shallow tips that are now fully included (every parent included).
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (!included.has(boundary)) continue;
    const view = store.commitOf(repo, boundary);
    if (view === undefined) continue;
    if (view.parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }

  // Objects to send: everything reachable from the included commits and wanted tags,
  // minus what the client holds.
  const send = new Map<string, GitObject>();
  for (const want of wants) {
    const root = store.getObject(repo, want);
    if (root === undefined) continue;
    if (root.type === 'tag') {
      for (const [oid, object] of reachableObjects(store, repo, want)) {
        if (!held.has(oid)) send.set(oid, object);
      }
      continue;
    }
    if (root.type !== 'commit') continue;
  }
  for (const [oid] of included) {
    if (held.has(oid)) continue;
    for (const [reachableOid, object] of commitOwnObjects(store, repo, oid)) {
      if (!held.has(reachableOid)) send.set(reachableOid, object);
    }
  }
  const acks = haves.filter((have) => store.getObject(repo, have) !== undefined);
  // `send` is already keyed by oid: sort by the keys instead of re-hashing every object
  // on every comparison (the old comparator hashed O(n log n) times).
  const objects = [...send.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, object]) => object);
  return { objects, shallow, unshallow, acks };
}

  // ---------------------------------------------------------------- HTTP handlers

  export function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  }

  function sendText(res: ServerResponse, status: number, text: string): void {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }

  /** GET /{owner}/{repo}.git/info/refs?service=... — v2 when Git-Protocol: version=2. */
  export function handleInfoRefs(
    req: IncomingMessage,
    res: ServerResponse,
    store: Store,
    owner: string,
    repoName: string,
    service: string,
  ): void {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendText(res, 404, 'Not Found\n');
      return;
    }
    if (service === 'git-receive-pack') {
      const key = 'adv:git-receive-pack';
      const cached = wireHit(repo, key);
      sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', cached ?? wireKeep(repo, key, v0Advertisement('git-receive-pack', store, repo)));
      return;
    }
    if (service !== 'git-upload-pack') {
      sendText(res, 400, 'unknown service\n');
      return;
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (wantsV2) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADS);
      return;
    }
    const key = 'adv:git-upload-pack';
    const cached = wireHit(repo, key);
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', cached ?? wireKeep(repo, key, v0Advertisement('git-upload-pack', store, repo)));
  }

  /** The v2 ls-refs answer: HEAD, the refs, peeled tags, honouring ref-prefix. */
  function handleLsRefs(store: Store, repo: Repo, args: string[]): Buffer {
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    let unborn = false;
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const parts: Buffer[] = [];
    const refs = listRefs(store, repo);
    const headTip = store.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    if (refs.length === 0) {
      if (unborn && keep('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      if (headTip !== undefined && keep('HEAD')) {
        parts.push(pktLine(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
      for (const ref of refs) {
        if (ref.name === 'HEAD' || !keep(ref.name)) continue;
        const peeled = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
        parts.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
      }
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  interface FetchRequest {
    readonly wants: string[];
    readonly haves: string[];
    readonly shallow: string[];
    readonly depth: number | null;
  }

  /** The v2 fetch answer: acknowledgments, shallow-info, then the packfile sideband. */
  function handleFetchV2(store: Store, repo: Repo, request: FetchRequest): Buffer {
    const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktDelim());
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(writePack(plan.objects)));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  /** The v0 fetch answer: NAK/ACK lines, shallow lines, then the packfile sideband. */
  function handleFetchV0(store: Store, repo: Repo, request: FetchRequest): Buffer {
    const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
    const parts: Buffer[] = [];
    if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(...sidebandPackets(writePack(plan.objects)));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }

  /** POST /{owner}/{repo}.git/git-upload-pack — v2 when Git-Protocol: version=2. */
  export function handleUploadPack(
    req: IncomingMessage,
    res: ServerResponse,
    store: Store,
    owner: string,
    repoName: string,
    body: Buffer,
  ): void {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendText(res, 404, 'Not Found\n');
      return;
    }
    let parsed: { packets: Packet[]; end: number };
    try {
      parsed = parsePktLines(body);
    } catch {
      sendText(res, 400, 'malformed pkt-line stream\n');
      return;
    }
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const lines = packetLines(parsed.packets);
    if (isV2) {
      const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length);
      const args = lines.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='));
      if (command === 'ls-refs') {
        const key = `ls-refs:${JSON.stringify(args)}`;
        const cached = wireHit(repo, key);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached ?? wireKeep(repo, key, handleLsRefs(store, repo, args)));
        return;
      }
      if (command === 'fetch') {
        const request = parseFetchArgs(args);
        const key = `fetch:v2:${JSON.stringify(request)}`;
        const cached = wireHit(repo, key);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached ?? wireKeep(repo, key, handleFetchV2(store, repo, request)));
        return;
      }
      sendText(res, 400, `unknown v2 command ${JSON.stringify(command)}\n`);
      return;
    }
    // v0: wants (with shallow/deepen) up to the first flush, then haves and done.
    const sections: string[][] = [[]];
    for (const packet of parsed.packets) {
      if (packet.kind === 'flush') sections.push([]);
      else if (packet.kind === 'data') sections[sections.length - 1]!.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const request = parseFetchArgs([...(sections[0] ?? []), ...(sections[1] ?? [])]);
    const key = `fetch:v0:${JSON.stringify(request)}`;
    const cached = wireHit(repo, key);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached ?? wireKeep(repo, key, handleFetchV0(store, repo, request)));
  }

  /** The want/have/shallow/deepen arguments of a fetch request, v2 or v0. */
  function parseFetchArgs(lines: string[]): FetchRequest {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('have ')) haves.push(line.slice(5));
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7), 10);
        if (Number.isFinite(n)) depth = n;
      }
    }
    return { wants, haves, shallow, depth };
  }

  // ---------------------------------------------------------------- receive-pack

  interface PushCommand {
    readonly oldOid: string;
    readonly newOid: string;
    readonly ref: string;
  }

  /** Whether `descendant` is the same commit as `ancestor` or descends from it. */
  function isFastForward(store: Store, repo: Repo, ancestor: string, descendant: string): boolean {
    const ancestorCommit = store.peelToCommit(repo, ancestor);
    const descendantCommit = store.peelToCommit(repo, descendant);
    if (ancestorCommit === undefined || descendantCommit === undefined) return false;
    return store.isAncestor(repo, ancestorCommit, descendantCommit);
  }

  /** POST /{owner}/{repo}.git/git-receive-pack — v0 only, report-status in sideband. */
  export function handleReceivePack(
    req: IncomingMessage,
    res: ServerResponse,
    store: Store,
    owner: string,
    repoName: string,
    body: Buffer,
  ): void {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendText(res, 404, 'Not Found\n');
      return;
    }
    // The command list is pkt-lined up to its flush; the pack follows as raw bytes,
    // so parse packet by packet and stop at the flush instead of parsing the whole body.
    const commands: PushCommand[] = [];
    let offset = 0;
    let sawFlush = false;
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (header === '0000') {
        offset += 4;
        sawFlush = true;
        break;
      }
      const length = Number.parseInt(header, 16);
      if (!Number.isFinite(length) || length < 4 || length > MAX_PKT_LINE || offset + length > body.length) {
        sendText(res, 400, 'malformed pkt-line stream\n');
        return;
      }
      const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const line = nul >= 0 ? text.slice(0, nul) : text;
      const parts = line.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
        sendText(res, 400, 'malformed push command\n');
        return;
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      offset += length;
    }
    if (!sawFlush) {
      sendText(res, 400, 'malformed pkt-line stream\n');
      return;
    }
    // The pack follows the command list's flush, as raw bytes.
    const packBytes = body.subarray(offset);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, {
          resolveBase: (oid) => store.getObject(repo, oid),
        });
        for (const object of read.objects.values()) store.storeObject(repo, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (!unpackOk) {
        reason = 'unpacker error';
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'remote ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
        else {
          repo.refs.delete(command.ref);
          store.bump(repo);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'already exists';
        else if (store.getObject(repo, command.newOid) === undefined) reason = 'object not found';
        else {
          repo.refs.set(command.ref, command.newOid);
          store.bump(repo);
          ok = true;
        }
      } else {
        // Update: the old value must match and the new tip must descend from it.
        if (current === undefined) reason = 'remote ref does not exist';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else if (store.getObject(repo, command.newOid) === undefined) reason = 'object not found';
        else if (!isFastForward(store, repo, current, command.newOid)) reason = 'non-fast-forward';
        else {
          repo.refs.set(command.ref, command.newOid);
          store.bump(repo);
          ok = true;
        }
      }
      reportLines.push(ok ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
    }
    const report = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)).concat([pktFlush()]));
    const out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
  }

  export { VIEWER_LOGIN };
