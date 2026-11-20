// The git object layer: canonical objects, SHA-1 addressing, tree/commit/tag codecs, packfile
// parsing (with ofs/ref deltas) and packfile generation. No git binary; node:zlib does the
// compressing. Everything here is protocol-agnostic: the smart-HTTP layer sits on top.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject } from './store.ts';

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export function sha1Of(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function typeCode(type: ObjType): number {
  return type === 'commit' ? OBJ_COMMIT : type === 'tree' ? OBJ_TREE : type === 'blob' ? OBJ_BLOB : OBJ_TAG;
}

// ---------------------------------------------------------------- trees

export type TreeEntry = { mode: string; name: string; sha: string };

/** Encode tree entries to canonical tree bytes (git sorts entries by name bytes; for dirs an implicit trailing '/'). */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => dirAwareCompare(a.name, isDir(a.mode), b.name, isDir(b.mode)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function isDir(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

function dirAwareCompare(an: string, aDir: boolean, bn: string, bDir: boolean): number {
  const a = aDir ? `${an}/` : an;
  const b = bDir ? `${bn}/` : bn;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Decode canonical tree bytes. */
export function decodeTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0) throw new Error('bad tree object');
    const mode = data.toString('utf8', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

// ---------------------------------------------------------------- commits / tags

export type Commit = {
  tree: string;
  parents: string[];
  author: { name: string; email: string; when: string }; // when: "<ts> <tz>"
  committer: { name: string; email: string; when: string };
  message: string;
};

export function encodeCommit(c: Commit): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${c.tree}`);
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author.name} <${c.author.email}> ${c.author.when}`);
  lines.push(`committer ${c.committer.name} <${c.committer.email}> ${c.committer.when}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

export function decodeCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = text.slice(0, headerEnd < 0 ? text.length : headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const commit: Commit = { tree: '', parents: [], author: { name: '', email: '', when: '' }, committer: { name: '', email: '', when: '' }, message };
  for (const line of header.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    if (key === 'tree') commit.tree = rest;
    else if (key === 'parent') commit.parents.push(rest);
    else if (key === 'author' || key === 'committer') {
      const m = /^(.*) <(.*)> (.*)$/.exec(rest);
      if (m) commit[key] = { name: m[1], email: m[2], when: m[3] };
    }
  }
  return commit;
}

export type Tag = { object: string; type: string; tag: string; tagger: { name: string; email: string; when: string } | null; message: string };

export function decodeTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = text.slice(0, headerEnd < 0 ? text.length : headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const tag: Tag = { object: '', type: '', tag: '', tagger: null, message };
  for (const line of header.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    if (key === 'object') tag.object = rest;
    else if (key === 'type') tag.type = rest;
    else if (key === 'tag') tag.tag = rest;
    else if (key === 'tagger') {
      const m = /^(.*) <(.*)> (.*)$/.exec(rest);
      if (m) tag.tagger = { name: m[1], email: m[2], when: m[3] };
    }
  }
  return tag;
}

// ---------------------------------------------------------------- packfile parsing

/** Apply a git delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const baseSize = readVarintAt(delta, i); i = baseSize.next;
  if (baseSize.value !== base.length) throw new Error(`delta base size mismatch: ${baseSize.value} != ${base.length}`);
  const resultSize = readVarintAt(delta, i); i = resultSize.next;
  const out = Buffer.allocUnsafe(resultSize.value);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      // copy from base
      let offset = 0, size = 0;
      if (op & 0x01) offset |= delta[i++] << 0;
      if (op & 0x02) offset |= delta[i++] << 8;
      if (op & 0x04) offset |= delta[i++] << 16;
      if (op & 0x08) offset |= delta[i++] << 24;
      if (op & 0x10) size |= delta[i++] << 0;
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op);
      i += op;
      o += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  if (o !== resultSize.value) throw new Error('delta result size mismatch');
  return out;
}

function readVarintAt(buf: Buffer, i: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  while (true) {
    if (i >= buf.length) throw new Error('varint out of range');
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: i };
}



export type ParsedObject =
  | { kind: 'full'; start: number; end: number; type: ObjType; data: Buffer }
  | { kind: 'ofs-delta'; start: number; end: number; baseOffset: number; delta: Buffer }
  | { kind: 'ref-delta'; start: number; end: number; base: string; delta: Buffer };

/**
 * Inflate the zlib stream that begins at `start` and report the offset just past it.
 * Packfiles store only the uncompressed size, so the stream's end is found by search:
 * inflateSync succeeds exactly when the slice covers the whole stream, which is monotonic
 * in the slice length — a binary search over a tight bound finds it in a few inflates.
 */
function inflateAt(pack: Buffer, start: number, uncompressedSize: number): { data: Buffer; end: number } {
  const remaining = pack.length - start;
  // Deflate's worst case is ~5 extra bytes per 16 KiB stored block plus the header;
  // the bound is generous but keeps the search slices small.
  const bound = Math.min(remaining, uncompressedSize + 128 + (uncompressedSize >> 8));
  let lo = Math.min(8, bound);
  let hi = bound;
  let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(pack.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  try {
    data = inflateSync(pack.subarray(start, start + lo));
  } catch {
    throw new Error(`bad zlib stream at offset ${start}`);
  }
  return { data, end: start + lo };
}

/**
 * Parse a packfile body into its objects (unresolved deltas included), each entry carrying
 * the absolute offset of its header and of the byte just past its compressed stream.
 */
export function parsePack(pack: Buffer): ParsedObject[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  // version at 4..8 (2), object count at 8..12
  const count = pack.readUInt32BE(8);
  const out: ParsedObject[] = [];
  let i = 12;
  for (let n = 0; n < count; n++) {
    const start = i;
    let b = pack[i++];
    const type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[i++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (type === OBJ_OFS_DELTA) {
      b = pack[i++];
      let rel = b & 0x7f;
      while (b & 0x80) {
        b = pack[i++];
        rel = ((rel + 1) << 7) | (b & 0x7f);
      }
      const { data, end } = inflateAt(pack, i, size);
      i = end;
      out.push({ kind: 'ofs-delta', start, end, baseOffset: start - rel, delta: data });
    } else if (type === OBJ_REF_DELTA) {
      const base = pack.toString('hex', i, i + 20);
      i += 20;
      const { data, end } = inflateAt(pack, i, size);
      i = end;
      out.push({ kind: 'ref-delta', start, end, base, delta: data });
    } else {
      const { data, end } = inflateAt(pack, i, size);
      i = end;
      if (data.length !== size) throw new Error(`object size mismatch: ${data.length} != ${size}`);
      out.push({ kind: 'full', start, end, type: OBJ_TYPES[type], data });
    }
  }
  return out;
}

const OBJ_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Deflate with zlib level 6 (git's default), no zlib header beyond the standard one. */
export function deflateObj(data: Buffer): Buffer {
  return deflateSync(data, { level: 6 });
}

/**
 * Build a packfile from a list of objects. Objects are written undeltified, in the order given
 * (callers pass a stable order so packs are byte-stable for the same tree).
 */
export function buildPack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    const size = obj.data.length;
    const type = typeCode(obj.type);
    const head: number[] = [(type << 4) | (size & 0x0f)];
    let rest = size >> 4;
    while (rest > 0) {
      head.push(rest & 0x7f);
      rest >>= 7;
    }
    for (let k = 0; k < head.length - 1; k++) head[k] |= 0x80;
    chunks.push(Buffer.from(head));
    chunks.push(deflateObj(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line: 4 hex length digits (including the 4 themselves) + payload. */
export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'latin1');
export const DELIM_PKT = Buffer.from('0001', 'latin1');

/** Read pkt-lines from a buffer until flush; returns {lines, rest} (rest = bytes after flush). */
export function readPkts(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('latin1', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) return { lines, rest: buf.subarray(i + 4) };
    if (len < 4) throw new Error(`bad pkt-line length ${len}`);
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    lines.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { lines, rest: buf.subarray(buf.length) };
}

/** Side-band-64k: mux data into channel-1 packets (progress goes to channel 2). */
export function sideBand(data: Buffer, bandSize = 65515): Buffer {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += bandSize) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + bandSize)])));
  }
  return Buffer.concat(chunks);
}
