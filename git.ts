// The git object model, packfile format and pkt-line framing, implemented from the public
// protocol specification (no git binary exists at runtime). Objects are content-addressed by
// SHA-1 over "<type> <size>\0" + payload and held in one in-memory store shared by every
// repository: identical bytes are the same object, whichever surface wrote them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType | 'ofs' | 'ref'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs',
  7: 'ref',
};

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** The one object store. Content addressing makes cross-repository deduplication automatic. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// -------------------------------------------------------------------------------------------------
// Commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  let object = ZERO_OID;
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Peel a ref target to the commit it ultimately names (through annotated tags), or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a ref target names when it is a tag (the peeled oid), else null. */
export function peeledOid(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(store, oid);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {mode, oid} for every blob (and submodule) under it. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild nested trees from a flattened path map; answers the root tree oid. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/** The entry at `path` inside a tree: a blob entry, a subtree entry, or null. */
export function treeEntryAt(store: ObjectStore, treeOid: string, path: string): TreeEntry | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000' && entry.mode !== '040000') return null;
    current = entry.oid;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Graph walks

/** Every object reachable from the given commits: commits, their trees and blobs, tags. */
export function closureOf(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  const pushObject = (oid: string): void => {
    if (!seen.has(oid)) {
      seen.add(oid);
      stack.push(oid);
    }
  };
  for (const tip of tips) pushObject(tip);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      pushObject(commit.tree);
      for (const parent of commit.parents) pushObject(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) pushObject(entry.oid);
    } else if (object.type === 'tag') {
      pushObject(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit-only ancestors of a tip, the tip included. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(store, descendant).has(ancestor);
}

/** A best common ancestor of two commits (the first one a breadth-first walk from `b` meets). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = commitAncestors(store, a);
  if (ancestorsOfA.has(b)) return b;
  if (commitAncestors(store, b).has(a)) return a;
  const seen = new Set<string>([b]);
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) return oid;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** Commits reachable from `tip`, newest first (breadth-first by generation). */
export function listCommits(store: ObjectStore, tip: string, limit = 10_000): string[] {
  const order: string[] = [];
  const seen = new Set<string>([tip]);
  let frontier = [tip];
  while (frontier.length > 0 && order.length < limit) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return order;
}

// -------------------------------------------------------------------------------------------------
// Packfiles

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack carrying the given objects whole (no deltas: always valid, always exact). */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) throw new Error(`writePack: unknown object ${oid}`);
    parts.push(packObjectHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('pack delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset]! * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize += delta[offset]! * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('pack delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('pack delta size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: ObjType | 'ofs' | 'ref';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a pack (version 2 or 3), resolving OFS-DELTA and REF-DELTA entries against the store. */
export function readPack(store: ObjectStore, pack: Buffer): { objects: Map<string, GitObject>; count: number } {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  const end = pack.length - 20;
  const byOffset = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const type = CODE_TYPES[(byte >> 4) & 0x07] ?? 'blob';
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: PackEntry = { offset: start, type, data: Buffer.alloc(0) };
    if (type === 'ofs') {
      let back = pack[offset]!;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset]!;
        offset += 1;
        value = (value + 1) * 128 + (back & 0x7f);
      }
      entry.baseOffset = start - value;
    } else if (type === 'ref') {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, end));
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    entry.data = inflated;
    offset = offset + consumedCompressedLength(pack.subarray(offset, end), inflated);
    byOffset.set(start, entries.length);
    entries.push(entry);
  }
  const resolved = new Map<number, GitObject>();
  const resolve = (index: number): GitObject => {
    const cached = resolved.get(index);
    if (cached !== undefined) return cached;
    const entry = entries[index]!;
    let object: GitObject;
    if (entry.type === 'ofs' || entry.type === 'ref') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs') {
        const baseIndex = byOffset.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIndex);
      } else {
        base = store.get(entry.baseOid!);
        if (base === undefined) {
          // The base may itself be an entry of this same pack.
          for (let i = 0; i < entries.length; i += 1) {
            const candidate = entries[i]!;
            if (candidate.type !== 'ofs' && candidate.type !== 'ref') {
              if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
                base = resolve(i);
                break;
              }
            }
          }
        }
        if (base === undefined) throw new Error('ref-delta base not available');
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved.set(index, object);
    return object;
  };
  const objects = new Map<string, GitObject>();
  for (let index = 0; index < entries.length; index += 1) {
    const object = resolve(index);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, count };
}

/**
 * The number of compressed bytes the zlib stream at the head of `buf` occupies, where
 * `inflated` is that stream's known output. Fast path: packs written by deflateSync with
 * default options recompress byte-identically, which pins the length in one step. Fallback:
 * zlib streams are self-terminating and a truncated stream throws, so the smallest prefix
 * that inflates to the full output is exactly the stream's length — binary-search for it.
 */
function consumedCompressedLength(buf: Buffer, inflated: Buffer): number {
  const recompressed = deflateSync(inflated);
  if (recompressed.length <= buf.length && buf.subarray(0, recompressed.length).equals(recompressed)) {
    return recompressed.length;
  }
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (inflatesFully(buf.subarray(0, mid), inflated.length)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function inflatesFully(buf: Buffer, expectedLength: number): boolean {
  try {
    return inflateSync(buf).length === expectedLength;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// pkt-lines

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/**
 * Parse a pkt-line stream; stops at the first malformed length and reports where. By default
 * parsing ends at the first flush packet (receive-pack's command list, a v2 request); a v0
 * fetch request carries its haves after a flush, so it opts out with `stopAtFlush: false`.
 */
export function parsePktLines(buf: Buffer, start = 0, stopAtFlush = true): { lines: PktLine[]; next: number; ok: boolean } {
  const lines: PktLine[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { lines, next: offset, ok: false };
    const length = parseInt(hex, 16);
    if (length === 0) {
      lines.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) return { lines, next: offset, ok: true };
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) return { lines, next: offset, ok: false };
    lines.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { lines, next: offset, ok: offset === buf.length };
}

/** Wrap pack bytes in side-band-64k band-1 packets (payload chunk 65516 - 1 band byte). */
export function sidebandWrap(pack: Buffer, chunkSize = 32768): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
