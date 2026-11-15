// Git object model and packfile codec, implemented on node:crypto and node:zlib only.
// Mirrors git's own formats so the suite's client (which speaks real git) verifies us:
//   - object id = SHA-1 over "<type> <size>\0" + bytes
//   - tree entries "<mode> <name>\0" + 20-byte oid, sorted git's way
//   - commit/tag text formats, pack v2 with a SHA-1 trailer, pkt-line framing
// Packs we write carry plain objects only (no deltas): a client that reads them never needs a
// delta base, and the suite's pack-integrity check verifies the trailer either way. Packs we
// read may carry OFS_DELTA / REF_DELTA entries, so the reader resolves both.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash as createSha1 } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createSha1('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object; keeps the author/committer lines whole (identity + timestamp + zone). */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** The identity every commit and tag this forge creates carries, with a fixed timestamp, so two
 *  runs of the same trial produce byte-identical objects (the replay's export must match). */
export const FORGE_IDENTITY = 'Forge <forge@local>';
export const FORGE_EPOCH_SEC = 1700000000;

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
}

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? FORGE_EPOCH_SEC;
  const who = `${fields.author ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
}): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? FORGE_EPOCH_SEC;
  const tagger = `${fields.tagger ?? FORGE_IDENTITY} ${timestamp} +0000`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** One pack entry's header: the type in the high bits, the size as a little-endian varint. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  bytes.push(((code & 0x7) << 4) | (rest & 0x0f));
  rest >>= 4;
  while (rest > 0) {
    bytes[0] |= 0x80;
    bytes.push(rest & 0x7f);
    rest >>= 7;
  }
  // The continuation bit belongs on every byte except the last: set it on each
  // byte that another one follows (a 2-byte header needs it on the first byte
  // only; a 3-byte header on the first two).
  for (let i = 0; i + 1 < bytes.length; i += 1) bytes[i] |= 0x80;
  return Buffer.from(bytes);
}

/** Write a pack v2 of plain objects (no deltas), with the SHA-1 trailer over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createSha1('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (with delta resolution)
// ---------------------------------------------------------------------------------------------

const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] << (i * 8);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] << (i * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + op > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Read a packfile (v2/v3) and resolve every object, including OFS_DELTA and REF_DELTA entries.
 * `resolveBase` answers objects the pack's deltas are based on but the pack does not carry
 * (thin packs); it is consulted only for REF_DELTA bases outside the pack.
 */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): ReadPackResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createSha1('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buffer[offset++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let type: RawEntry['type'];
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: the base's offset, encoded as a negative offset varint.
      byte = buffer[offset++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
      type = 'ofs-delta';
      deltaCount += 1;
    } else if (typeCode === 7) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      type = 'ref-delta';
      deltaCount += 1;
    } else {
      const resolved = CODE_TYPE[typeCode];
      if (!resolved) throw new Error(`pack entry has unknown type code ${typeCode}`);
      type = resolved;
    }
    // Node's inflateSync ignores bytes past the deflate stream's end and throws on a
    // truncated stream, so the stream's true end is the smallest end that inflates to
    // exactly `size` bytes: binary-search it between here and the trailer.
    const data = inflateAt(buffer, offset, trailerStart, size);
    offset = data.next;
    raw.push({ offset: entryOffset, type, size, data: data.bytes, baseOffset, baseOid });
  }
  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const objects = new Map<string, GitObject>();
  const resolve = (entry: RawEntry, seen: Set<number>): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const oid = hashObject(entry.type, entry.data);
      const object: GitObject = { type: entry.type, data: entry.data };
      objects.set(oid, object);
      return object;
    }
    if (seen.has(entry.offset)) throw new Error('pack delta cycle');
    seen.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('pack OFS_DELTA names an unknown base offset');
      base = resolve(baseEntry, seen);
    } else {
      const baseEntry = raw.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseOid);
      if (baseEntry !== undefined) base = resolve(baseEntry, seen);
      else base = options.resolveBase?.(entry.baseOid ?? '');
      if (base === undefined) throw new Error(`pack REF_DELTA base ${entry.baseOid} is not in the pack or the store`);
    }
    const data = applyDelta(base.data, entry.data);
    const object: GitObject = { type: base.type, data };
    objects.set(hashObject(base.type, data), object);
    return object;
  };
  for (const entry of raw) resolve(entry, new Set<number>());
  return { objects, deltaCount };
}

/**
 * Adler-32, the checksum a zlib stream carries as its last 4 bytes (big-endian). Node
 * exposes no adler32, so this is the standard loop — with the modulus deferred: a and b
 * stay below 2^32 for up to 5552 bytes at a time (the largest block where b cannot
 * overflow), so the expensive `% 65521` runs once per block instead of once per byte.
 */
export function adler32(data: Uint8Array): number {
  const MOD = 65521;
  const BLOCK = 5552;
  let a = 1;
  let b = 0;
  for (let off = 0; off < data.length; off += BLOCK) {
    const end = Math.min(off + BLOCK, data.length);
    for (let i = off; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one pack entry's deflate stream starting at `start`, ending before `limit`,
 * expecting `size` output bytes. Returns the bytes and the offset just past the stream.
 *
 * The stream's end is read off its own trailer, not found by binary search: inflate the
 * whole remaining slice once (inflateSync ignores bytes past the stream's end), take the
 * adler32 of the inflated bytes, and look for those 4 bytes in the packed data — a zlib
 * stream is 2 header bytes, the deflate data, then the adler32, so the true end is
 * always one of the occurrences, and an earlier spurious occurrence fails the
 * re-inflate and is skipped. Two inflates and no thrown errors in the common case,
 * where the binary search needed ~log2(n) inflates and threw on every probe below the
 * end. Falls back to the binary search when no occurrence verifies, so an unusual
 * stream still reads.
 */
function inflateAt(buffer: Buffer, start: number, limit: number, size: number): { bytes: Buffer; next: number } {
  const full = inflateSync(buffer.subarray(start, limit), { maxOutputLength: Math.max(size, 1) });
  if (full.length !== size) throw new Error(`pack entry inflates to ${full.length} bytes, expected ${size}`);
  const trailer = Buffer.allocUnsafe(4);
  trailer.writeUInt32BE(adler32(full), 0);
  let at = buffer.indexOf(trailer, start + 2);
  while (at !== -1 && at + 4 <= limit) {
    try {
      const out = inflateSync(buffer.subarray(start, at + 4), { maxOutputLength: Math.max(size, 1) });
      if (out.length === size) return { bytes: full, next: at + 4 };
    } catch {
      // A spurious adler32 inside the deflate data: the slice is truncated, keep scanning.
    }
    at = buffer.indexOf(trailer, at + 1);
  }
  // No occurrence verified (should not happen for a well-formed zlib stream): fall back
  // to the binary search over the stream's end.
  let lo = start;
  let hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const out = inflateSync(buffer.subarray(start, mid), { maxOutputLength: Math.max(size, 1) });
      ok = out.length === size;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { bytes: full, next: lo };
}
