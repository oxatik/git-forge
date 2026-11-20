// Git smart HTTP: info/refs advertisements (protocol v0 and v2), ls-refs, fetch (v2 + v0,
// full and shallow), receive-pack with report-status, and packfile generation. The suite's
// own in-process client is the only consumer; it is strict about pkt-line framing,
// capability names, section names and report grammar, so those are exact here.

import {
  FLUSH_PKT,
  pkt,
  buildPack,
  parsePack,
  applyDelta,
  type ObjType,
} from './git-objects.ts';
import { createHash } from 'node:crypto';
import { sha1Loose, putObject, type Repo } from './store.ts';
import { readCommit, isAncestorEarlyExit, getObject } from './treeops.ts';
import { decodeTag } from './git-objects.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'agent=makefun-forge/1';
const UPLOAD_PACK_V2_CAPS = [
  'object-format=sha1',
  'ls-refs=unborn',
  'fetch=shallow filter thin-pack side-band-64k ofs-delta',
  AGENT,
];
const UPLOAD_PACK_V0_CAPS = [
  'symref=HEAD:refs/heads/main', // replaced per repo below
  'multi_ack_detailed',
  'multi_ack',
  'side-band-64k',
  'shallow',
  'thin-pack',
  'ofs-delta',
  'no-progress',
  'include-tag',
  AGENT,
];
const RECEIVE_PACK_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', AGENT];

export class GitHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
  }
}

function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** HEAD's target ref name for a repo. */
function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function resolve(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** v2 capability advertisement for upload-pack. */
function advertiseV2(repo: Repo): Buffer {
  const lines = ['# service=git-upload-pack\n', 'version 2\n', ...UPLOAD_PACK_V2_CAPS.map((c) => `${c}\n`)];
  const body = Buffer.concat([pkt(lines[0]), ...lines.slice(1).map(pkt), FLUSH_PKT]);
  void repo;
  return body;
}

/** The v0 ref advertisement lines (upload-pack or receive-pack). */
function v0RefLines(repo: Repo, caps: string, advertiseHead: boolean): Buffer[] {
  const out: Buffer[] = [];
  const headTarget = headRef(repo);
  const headSha = resolve(repo, headTarget);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (refs.length === 0) {
    // Unborn: the capabilities^{} pseudo-ref is the only line.
    out.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return out;
  }
  const headResolved = advertiseHead && headSha !== undefined;
  const firstCaps = headResolved ? caps : caps.replace(/^symref=HEAD:refs\/heads\/[^ ]* /, '');
  const lines: string[] = [];
  if (headResolved) lines.push(`${headSha} HEAD\0${firstCaps}\n`);
  else lines.push(`${refs[0][1]} ${refs[0][0]}\0${firstCaps}\n`);
  for (const [name, sha] of refs) {
    lines.push(`${sha} ${name}\n`);
    const peeled = peel(repo, sha);
    if (peeled && peeled !== sha) lines.push(`${peeled} ${name}^{}\n`);
  }
  for (const line of lines) out.push(pkt(line));
  return out;
}

/** Peel a tag object to the underlying non-tag object sha; null when not a tag. */
function peel(repo: Repo, sha: string): string | null {
  let current = sha;
  for (let i = 0; i < 10; i++) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tag') return i === 0 ? null : current;
    const tag = decodeTag(obj.data);
    if (!tag.object) return null;
    current = tag.object;
  }
  return null;
}

function advertiseV0(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = service === 'upload' ? UPLOAD_PACK_V0_CAPS.join(' ').replace(/^symref=HEAD:refs\/heads\/main /, `symref=HEAD:${headRef(repo)} `) : RECEIVE_PACK_CAPS.join(' ');
  const headTarget = headRef(repo);
  const headSha = resolve(repo, headTarget);
  let capLine = caps;
  if (service === 'receive' && headSha !== undefined) capLine = capLine.replace('report-status', `symref=HEAD:${headTarget} report-status`);
  const preamble = pkt(`# service=git-${service}-pack\n`);
  const refLines = v0RefLines(repo, capLine, service === 'upload');
  return Buffer.concat([preamble, ...refLines, FLUSH_PKT]);
}

/** GET /<owner>/<repo>.git/info/refs?service=… */
export function infoRefs(repo: Repo, service: string, protocolV2: boolean): { contentType: string; body: Buffer } {
  const kind = service === 'git-upload-pack' ? (protocolV2 ? 'up2' : 'up0') : service === 'git-receive-pack' ? 'rp' : null;
  if (kind === null) throw new GitHttpError('bad service', 400);
  const contentType = kind === 'rp' ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-upload-pack-advertisement';
  // The advertisement depends only on the refs (and the default branch), both captured by the
  // repo's pack version: cache the bytes so repeated exchanges skip the rebuild.
  const cache = repoCache(repo);
  const key = `adv|${kind}|v${packVersionOf(repo)}`;
  let body = cache.get(key);
  if (!body) {
    body = kind === 'rp' ? advertiseV0(repo, 'receive') : protocolV2 ? advertiseV2(repo) : advertiseV0(repo, 'upload');
    cache.set(key, body);
  }
  return { contentType, body };
}

// ---------------------------------------------------------------- ls-refs (v2)

/** The repo's cache of rebuilt git protocol responses; every entry is keyed by the pack version. */
type RepoGitCache = Map<string, Buffer>;
function repoCache(repo: Repo): RepoGitCache {
  return ((repo as Repo & { fetchCache?: Map<string, unknown> }).fetchCache ??= new Map()) as RepoGitCache;
}
function packVersionOf(repo: Repo): number {
  return (repo as Repo & { packVersion?: number }).packVersion ?? 0;
}

/** Handle a v2 ls-refs request body. */
export function lsRefs(repo: Repo, body: Buffer): Buffer {
  const cache = repoCache(repo);
  const key = `ls|${body.toString('latin1')}|v${packVersionOf(repo)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = lsRefsBuild(repo, body);
  cache.set(key, built);
  return built;
}

function lsRefsBuild(repo: Repo, body: Buffer): Buffer {
  const prefixes: string[] = [];
  let wantPeel = false;
  let symrefs = false;
  let unborn = false;
  let pastDelim = false;
  for (const raw of readAllPackets(body)) {
    const text = raw.toString('utf8');
    if (text === FLUSH_SENTINEL) continue;
    if (text === DELIM_SENTINEL) {
      pastDelim = true;
      continue;
    }
    if (!pastDelim) {
      if (text.startsWith('command=') || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    } else {
      if (text === 'peel' || text === 'peel\n') wantPeel = true;
      else if (text === 'symrefs' || text === 'symrefs\n') symrefs = true;
      else if (text === 'unborn' || text === 'unborn\n') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length).replace(/\n$/, ''));
    }
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const headTarget = headRef(repo);
  const headSha = resolve(repo, headTarget);
  if (headSha !== undefined) {
    if (matches('HEAD')) {
      const suffix = symrefs ? ` symref-target:${headTarget}` : '';
      out.push(pkt(`${headSha} HEAD${suffix}\n`));
    }
  } else if (unborn && matches('HEAD')) {
    out.push(pkt(symrefs ? `unborn HEAD symref-target:${headTarget}\n` : 'unborn HEAD\n'));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, sha] of refs) {
    if (!matches(name)) continue;
    let suffix = '';
    if (symrefs && name === headTarget) suffix += ` symref-target:${headTarget}`;
    if (wantPeel) {
      const peeled = peel(repo, sha);
      if (peeled && peeled !== sha) suffix += ` peeled:${peeled}`;
    }
    out.push(pkt(`${sha} ${name}${suffix}\n`));
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

const DELIM_SENTINEL = '\x01delim\x01';
const FLUSH_SENTINEL = '\x01flush\x01';

/** Split a pkt-line stream into payloads, marking delim and flush packets with sentinels, reading to the end. */
function readAllPackets(body: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const hex = body.toString('latin1', i, i + 4);
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push(Buffer.from(FLUSH_SENTINEL, 'utf8'));
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push(Buffer.from(DELIM_SENTINEL, 'utf8'));
      i += 4;
      continue;
    }
    if (i + len > body.length) break;
    packets.push(body.subarray(i + 4, i + len));
    i += len;
  }
  return packets;
}

/** Packets up to (and excluding) the first flush — for bodies that end their pkt-line section there. */
function readUntilFlushes(body: Buffer): { packets: Buffer[] } {
  const packets: Buffer[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const hex = body.toString('latin1', i, i + 4);
    const len = parseInt(hex, 16);
    if (len === 0 || len === 1) break;
    if (i + len > body.length) break;
    packets.push(body.subarray(i + 4, i + len));
    i += len;
  }
  return { packets };
}

// ---------------------------------------------------------------- fetch

type FetchRequest = {
  v2: boolean;
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
};

function parseFetch(body: Buffer): FetchRequest {
  const req: FetchRequest = { v2: false, wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of readAllPackets(body)) {
    const text = raw.toString('utf8').replace(/\n$/, '');
    if (text === FLUSH_SENTINEL || text === DELIM_SENTINEL) continue;
    if (text.startsWith('command=')) {
      if (text !== 'command=fetch') throw new GitHttpError(`unexpected command ${text}`, 400);
      req.v2 = true;
      continue;
    }
    if (text.startsWith('want ')) {
      const oid = text.slice(5);
      if (!isObjectId(oid)) throw new GitHttpError(`bad want ${oid}`);
      if (!req.wants.includes(oid)) req.wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5);
      if (!isObjectId(oid)) throw new GitHttpError(`bad have ${oid}`);
      if (!req.haves.includes(oid)) req.haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8);
      if (!isObjectId(oid)) throw new GitHttpError(`bad shallow ${oid}`);
      if (!req.shallow.includes(oid)) req.shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7));
      if (!Number.isInteger(n) || n < 0) throw new GitHttpError(`bad deepen ${text}`);
      req.depth = n;
    } else if (text === 'done') {
      req.done = true;
    } else if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta' || text.startsWith('filter ') || text.startsWith('deepen-since ') || text.startsWith('deepen-not ') || text === 'include-tag') {
      // accepted and ignored (no deltas are ever generated; no filters are exercised)
    } else if (text.startsWith('agent=') || text.startsWith('object-format=')) {
      // ignored
    } else if (text === '') {
      // stray
    } else {
      throw new GitHttpError(`unrecognized fetch line ${JSON.stringify(text)}`);
    }
  }
  return req;
}

/** Every object reachable from the given tips; commits named in `boundaryStops` are leaves (their parents are not followed). */
function closureLimited(repo: Repo, tips: Iterable<string>, boundaryStops: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) if (repo.objects.has(tip)) stack.push(tip);
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = getObject(repo, sha);
    if (!obj) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const c = readCommit(repo, sha);
      if (c) {
        stack.push(c.tree); // a boundary commit's trees/blobs are held (the shallow clone carried them)
        if (!boundaryStops.has(sha)) for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of decodeTreeSafe(obj.data)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const tag = decodeTag(obj.data);
      if (tag.object) stack.push(tag.object);
    }
  }
  return seen;
}

/** Every object reachable from the given tips (commits with parents, their trees/blobs, tags). */
function closure(repo: Repo, tips: Iterable<string>): Set<string> {
  return closureLimited(repo, tips, new Set<string>());
}

function decodeTreeSafe(data: Buffer): Array<{ mode: string; name: string; sha: string }> {
  try {
    return decodeTreeLocal(data);
  } catch {
    return [];
  }
}

// Local import alias to avoid a cycle with treeops (treeops imports store only).
import { decodeTree as decodeTreeLocal } from './git-objects.ts';

/** Commits within `depth` generations of any want (1 = the want itself). */
function shallowCommits(repo: Repo, wants: string[], depth: number): Set<string> {
  const included = new Set<string>();
  let frontier = wants.filter((w) => repo.objects.has(w));
  let gen = 0;
  while (frontier.length > 0 && gen < depth) {
    gen += 1;
    const next: string[] = [];
    for (const sha of frontier) {
      if (included.has(sha)) continue;
      included.add(sha);
      const c = readCommit(repo, sha);
      if (c && gen < depth) next.push(...c.parents);
    }
    frontier = next;
  }
  return included;
}

/**
 * Compute the objects to send for a fetch and the shallow boundary lines.
 * Full fetch: closure(wants) − closure(haves). Shallow: commits within depth of wants
 * (with held generations subtracted), plus their complete trees/blobs.
 */
function computeSendSet(repo: Repo, req: FetchRequest): { objects: Array<{ type: ObjType; data: Buffer }>; shallowOut: string[]; unshallowOut: string[] } {
  let haveClosure = closure(repo, req.haves);
  const ordered: string[] = [];
  const sendSet = new Set<string>();
  const addTreeClosure = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (sendSet.has(sha) || haveClosure.has(sha)) continue;
      const obj = getObject(repo, sha);
      if (!obj) continue;
      sendSet.add(sha);
      ordered.push(sha);
      if (obj.type === 'tree') for (const e of decodeTreeSafe(obj.data)) stack.push(e.sha);
    }
  };
  const addTagClosure = (sha: string): void => {
    let current = sha;
    for (let i = 0; i < 10; i++) {
      if (sendSet.has(current) || haveClosure.has(current)) return;
      const obj = getObject(repo, current);
      if (!obj) return;
      sendSet.add(current);
      ordered.push(current);
      if (obj.type !== 'tag') return;
      const tag = decodeTag(obj.data);
      if (!tag.object) return;
      current = tag.object;
    }
  };

  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];

  if (req.depth === null) {
    // Full fetch: everything reachable from wants minus what the client holds.
    const wantClosure = closure(repo, req.wants);
    for (const sha of wantClosure) {
      if (haveClosure.has(sha)) continue;
      const obj = getObject(repo, sha)!;
      sendSet.add(sha);
      ordered.push(sha);
      void obj;
    }
  } else {
    // Shallow fetch. The client holds its haves but NOT the ancestors beyond its shallow
    // boundary, so the held set must treat the boundary commits as leaves.
    haveClosure = closureLimited(repo, req.haves, new Set(req.shallow));
    // Shallow fetch. Generation budget: commits within `depth` of the wants.
    const within = shallowCommits(repo, req.wants, req.depth);
    // Subtract what the client already holds (its haves cover the held generations).
    const commits: string[] = [];
    for (const sha of within) {
      if (haveClosure.has(sha)) continue;
      commits.push(sha);
      sendSet.add(sha);
      ordered.push(sha);
    }
    // Trees and blobs of the commits we send.
    for (const sha of commits) {
      const c = readCommit(repo, sha);
      if (c) addTreeClosure(c.tree);
    }
    // Annotated tags wanted directly.
    for (const w of req.wants) {
      const obj = getObject(repo, w);
      if (obj && obj.type === 'tag') addTagClosure(w);
    }
    // Boundary: sent commits whose parents were neither sent nor already held.
    for (const sha of commits) {
      const c = readCommit(repo, sha);
      if (!c) continue;
      if (c.parents.length === 0) {
        unshallowOut.push(sha); // the client's boundary opened to a root commit
      } else if (c.parents.some((p) => !sendSet.has(p) && !haveClosure.has(p))) {
        shallowOut.push(sha);
      }
    }
  }

  const objects = ordered.map((sha) => {
    const obj = getObject(repo, sha)!;
    return { type: obj.type as ObjType, data: obj.data };
  });
  return { objects, shallowOut, unshallowOut };
}

/** Build the v2 fetch response (sections: acknowledgments, shallow-info, packfile). */
function fetchV2(repo: Repo, req: FetchRequest, packCacheKey: string): Buffer {
  // The whole response is a pure function of (repo version, request): cache the bytes.
  const cache = repoCache(repo);
  const key = `resp|${packCacheKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH_PKT);
  const { objects, shallowOut, unshallowOut } = sendSetCached(repo, req, packCacheKey);
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of shallowOut) parts.push(pkt(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(FLUSH_PKT);
  }
  parts.push(pkt('packfile\n'));
  const pack = buildPack(objects);
  parts.push(...band1Chunks(pack));
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  cache.set(key, out);
  return out;
}

/** Build the v0 fetch response (shallow/unshallow lines, NAK, sideband pack). */
function fetchV0(repo: Repo, req: FetchRequest, packCacheKey: string): Buffer {
  const cache = repoCache(repo);
  const key = `resp|${packCacheKey}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts: Buffer[] = [];
  const { objects, shallowOut, unshallowOut } = sendSetCached(repo, req, packCacheKey);
  for (const s of shallowOut) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallowOut) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(pkt('NAK\n'));
  const pack = buildPack(objects);
  parts.push(...band1Chunks(pack));
  parts.push(FLUSH_PKT);
  const out = Buffer.concat(parts);
  cache.set(key, out);
  return out;
}

/** The cached send-set: the same fetch against the same repo version reuses its result. */
function sendSetCached(repo: Repo, req: FetchRequest, packCacheKey: string): { objects: Array<{ type: ObjType; data: Buffer }>; shallowOut: string[]; unshallowOut: string[] } {
  const cache = (repo as Repo & { fetchCache?: Map<string, { objects: Array<{ type: ObjType; data: Buffer }>; shallowOut: string[]; unshallowOut: string[]; pack?: Buffer }> }).fetchCache ??= new Map();
  const key = packCacheKey;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = computeSendSet(repo, req);
  cache.set(key, result);
  return result;
}

/** Split pack bytes into band-1 sideband pkt-lines (≤65515 payload bytes each). */
function band1Chunks(pack: Buffer): Buffer[] {
  if (pack.length === 0) return [];
  const chunks: Buffer[] = [];
  const BAND = 65515 - 0; // 65535 pkt cap − 4 header − 1 band byte
  for (let i = 0; i < pack.length; i += BAND) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(i + BAND, pack.length))])));
  }
  return chunks;
}

export function handleUploadPack(repo: Repo, body: Buffer, protocolV2: boolean): { contentType: string; body: Buffer } {
  const first = readUntilFlushes(body).packets[0]?.toString('utf8') ?? '';
  if (first.startsWith('command=') || protocolV2) {
    const { packets } = readUntilFlushes(body);
    const command = packets.find((p) => p.toString('utf8').startsWith('command='))?.toString('utf8').trim();
    if (command === 'command=ls-refs') return { contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, body) };
    if (command === 'command=fetch') {
      const req = parseFetch(body);
      const key = `v2|${req.wants.join(',')}|${req.haves.join(',')}|${req.depth ?? '-'}|v${(repo as Repo & { packVersion?: number }).packVersion ?? 0}`;
      return { contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, req, key) };
    }
    throw new GitHttpError(`unknown v2 command ${command ?? ''}`, 400);
  }
  const req = parseFetch(body);
  const key = `v0|${req.wants.join(',')}|${req.haves.join(',')}|${req.depth ?? '-'}|v${(repo as Repo & { packVersion?: number }).packVersion ?? 0}`;
  return { contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, req, key) };
}

// ---------------------------------------------------------------- receive-pack (push)

export type PushCommand = { oldSha: string; newSha: string; ref: string };

type ParsedPush = { commands: PushCommand[]; caps: string[]; pack: Buffer | null };

function parsePush(body: Buffer): ParsedPush {
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const hex = body.toString('latin1', i, i + 4);
    const len = parseInt(hex, 16);
    if (len === 0) {
      i += 4;
      break; // flush: packfile follows
    }
    if (i + len > body.length) throw new GitHttpError('truncated push command');
    let payload = body.toString('utf8', i + 4, i + len);
    i += len;
    const nul = payload.indexOf('\0');
    if (nul >= 0) {
      caps = payload.slice(nul + 1).trim().split(/\s+/).filter(Boolean);
      payload = payload.slice(0, nul);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+?)\n?$/.exec(payload);
    if (!m) throw new GitHttpError(`bad push command ${JSON.stringify(payload)}`);
    commands.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  }
  const pack = i < body.length ? body.subarray(i) : null;
  return { commands, caps, pack };
}

/** Store a client pack into the repo; returns the number of new objects. */
function storePack(repo: Repo, pack: Buffer): number {
  if (pack.length === 0) return 0;
  // Trailer check: SHA-1 of everything before the last 20 bytes must equal the trailer.
  if (pack.length < 32) throw new GitHttpError('pack too short');
  const trailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(pack.subarray(pack.length - 20))) throw new GitHttpError('pack checksum mismatch');
  const entries = parsePack(pack);
  const shaByStart = new Map<number, string>();
  let stored = 0;
  const putResolved = (type: string, data: Buffer): string => {
    const sha = sha1Loose(type, data.length, data);
    if (!repo.objects.has(sha)) {
      repo.objects.set(sha, { type: type as 'blob' | 'tree' | 'commit' | 'tag', data });
      stored += 1;
    }
    return sha;
  };
  for (const entry of entries) {
    if (entry.kind === 'full') {
      shaByStart.set(entry.start, putResolved(entry.type, entry.data));
    } else if (entry.kind === 'ofs-delta') {
      const baseSha = shaByStart.get(entry.baseOffset);
      if (!baseSha) throw new GitHttpError('ofs-delta base not found');
      const base = repo.objects.get(baseSha)!;
      shaByStart.set(entry.start, putResolved(base.type, applyDelta(base.data, entry.delta)));
    } else {
      const baseSha = entry.base;
      const base = repo.objects.get(baseSha);
      if (!base) throw new GitHttpError('ref-delta base not found');
      shaByStart.set(entry.start, putResolved(base.type, applyDelta(base.data, entry.delta)));
    }
  }
  return stored;
}

/** Handle a push; returns the response body (report-status, sideband per request). */
export function handleReceivePack(repo: Repo, body: Buffer): { contentType: string; body: Buffer } {
  let parsed: ParsedPush;
  let unpackLine = 'unpack ok\n';
  const refLines: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  try {
    parsed = parsePush(body);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'failed';
    return report(repo, false, [], `unpack ${detail}\n`, false);
  }
  const sideband = parsed.caps.includes('side-band-64k');
  let ok = true;
  try {
    if (parsed.pack && parsed.pack.length > 0) {
      storePack(repo, parsed.pack);
    } else if (parsed.commands.some((c) => c.newSha !== ZERO_OID && c.oldSha !== ZERO_OID)) {
      throw new GitHttpError('missing packfile');
    } else if (parsed.commands.some((c) => c.oldSha === ZERO_OID && c.newSha !== ZERO_OID)) {
      // Branch creation at an existing commit: a 0-object pack may or may not be present.
    }
  } catch (err) {
    ok = false;
    unpackLine = `unpack ${err instanceof Error ? err.message : 'index-pack failed'}\n`;
  }
  if (ok) {
    for (const cmd of parsed.commands) {
      const current = repo.refs.get(cmd.ref);
      let verdict: { ok: boolean; reason?: string };
      if (cmd.newSha === ZERO_OID) {
        // delete
        if (current !== undefined && (cmd.oldSha === current || cmd.oldSha === ZERO_OID)) {
          repo.refs.delete(cmd.ref);
          verdict = { ok: true };
        } else {
          verdict = { ok: false, reason: 'failed to delete' };
        }
      } else if (!isObjectId(cmd.newSha) || !repo.objects.has(cmd.newSha)) {
        verdict = { ok: false, reason: 'missing necessary objects' };
      } else if (cmd.oldSha === ZERO_OID) {
        if (current !== undefined) verdict = { ok: false, reason: 'ref already exists' };
        else {
          repo.refs.set(cmd.ref, cmd.newSha);
          verdict = { ok: true };
        }
      } else if (current !== cmd.oldSha) {
        verdict = { ok: false, reason: 'fetch first' };
      } else {
        // Fast-forward check: the old commit must be an ancestor of the new one (walk exits as
        // soon as the old commit is seen — the pushed commit's parent usually answers at once).
        const oldObj = repo.objects.get(cmd.oldSha);
        const newObj = repo.objects.get(cmd.newSha);
        if (oldObj && newObj && oldObj.type === 'commit' && newObj.type === 'commit' && !isAncestorEarlyExit(repo, cmd.oldSha, cmd.newSha)) {
          verdict = { ok: false, reason: 'non-fast-forward' };
        } else {
          repo.refs.set(cmd.ref, cmd.newSha);
          verdict = { ok: true };
        }
      }
      refLines.push({ ref: cmd.ref, ok: verdict.ok, reason: verdict.reason });
      if (verdict.ok) bumpPackVersion(repo);
    }
  } else {
    for (const cmd of parsed.commands) refLines.push({ ref: cmd.ref, ok: false, reason: 'n/a' });
  }
  return report(repo, sideband, refLines, unpackLine, ok);
}

function bumpPackVersion(repo: Repo): void {
  const r = repo as Repo & { packVersion?: number; fetchCache?: Map<string, unknown> };
  r.packVersion = (r.packVersion ?? 0) + 1;
  r.fetchCache?.clear();
}

/** Assemble the report-status response. */
function report(repo: Repo, sideband: boolean, refLines: Array<{ ref: string; ok: boolean; reason?: string }>, unpackLine: string, unpackOk: boolean): { contentType: string; body: Buffer } {
  void repo;
  const inner: Buffer[] = [pkt(unpackLine)];
  if (unpackOk) {
    for (const line of refLines) {
      inner.push(pkt(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`));
    }
  }
  const payload = Buffer.concat(inner);
  const body = sideband ? Buffer.concat([...band1Chunks(payload), FLUSH_PKT]) : Buffer.concat([payload, FLUSH_PKT]);
  return { contentType: 'application/x-git-receive-pack-result', body };
}
