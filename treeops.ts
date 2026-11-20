// Tree operations over the in-repo object store: building nested trees from flat path maps,
// reading trees back, diffing two trees (for PR files) and a three-way merge (for pulls).
// All objects live in repo.objects as canonical loose objects.

import { encodeTree, decodeTree, type TreeEntry, sha1Of } from './git-objects.ts';
import { putObject, type GitObject, type Repo } from './store.ts';

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha.toLowerCase());
}

/** Read a tree object into entries; null when sha is not a tree we hold. */
export function readTree(repo: Repo, sha: string): TreeEntry[] | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'tree') return null;
  return decodeTree(obj.data);
}

/** Flatten a tree object into path -> {sha, mode} (files only, all depths). */
export function flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const entries = readTree(repo, treeSha);
  if (!entries) return out;
  for (const e of entries) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (isDirMode(e.mode)) {
      flattenTree(repo, e.sha, path, out);
    } else {
      out.set(path, { sha: e.sha, mode: e.mode });
    }
  }
  return out;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/**
 * Build (or reuse) nested trees for a flat path -> blob-sha map, storing every tree object.
 * Returns the root tree sha. Empty map yields the empty tree.
 */
export function buildTree(repo: Repo, files: Map<string, string>): string {
  interface Node { dirs: Map<string, Node>; files: Map<string, string> }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/').filter((p) => p.length > 0);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], sha);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    const data = encodeTree(entries);
    return putObject(repo, 'tree', data);
  };
  return build(root);
}

/** Commit a set of files as a new commit on a ref; returns the commit sha. */
export function commitFiles(
  repo: Repo,
  files: Map<string, string>, // full flat tree after the change
  parentShas: string[],
  message: string,
  author: { name: string; email: string },
  whenSec: number,
): string {
  const treeSha = buildTree(repo, files);
  const lines: string[] = [`tree ${treeSha}`];
  for (const p of parentShas) lines.push(`parent ${p}`);
  const when = `${whenSec} +0000`;
  lines.push(`author ${author.name} <${author.email}> ${when}`);
  lines.push(`committer ${author.name} <${author.email}> ${when}`);
  const body = Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
  return putObject(repo, 'commit', body);
}

/** Load the flat file map of a commit (or null when the commit is absent). */
export function commitMap(repo: Repo, commitSha: string): Map<string, string> | null {
  const c = readCommit(repo, commitSha);
  if (!c) return null;
  return flattenTree(repo, c.tree);
}

export type ParsedCommit = { tree: string; parents: string[]; message: string; authorLine: string; committerLine: string; raw: Buffer };

/** Parse a commit object we hold. */
export function readCommit(repo: Repo, sha: string): ParsedCommit | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const parsed: ParsedCommit = { tree: '', parents: [], message, authorLine: '', committerLine: '', raw: obj.data };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) parsed.tree = line.slice(5);
    else if (line.startsWith('parent ')) parsed.parents.push(line.slice(7));
    else if (line.startsWith('author ')) parsed.authorLine = line.slice(7);
    else if (line.startsWith('committer ')) parsed.committerLine = line.slice(10);
  }
  return parsed;
}

/** All ancestors of a commit (including itself), by sha. */
export function ancestors(repo: Repo, commitSha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [commitSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = readCommit(repo, sha);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return seen;
}

/** First common ancestor of two commits (the merge base); null when unrelated. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = ancestors(repo, a);
  // Walk b's history newest-first; the first commit also reachable from a is the base.
  const seenB = new Set<string>();
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (seenB.has(sha)) continue;
      seenB.add(sha);
      if (aAncestors.has(sha)) return sha;
      const c = readCommit(repo, sha);
      if (c) next.push(...c.parents);
    }
    frontier = next;
  }
  return null;
}

/** Fast-forward check: is `old` an ancestor of `new` (or equal)? */
export function isAncestorOrEqual(repo: Repo, oldSha: string, newSha: string): boolean {
  if (oldSha === newSha) return true;
  return ancestors(repo, newSha).has(oldSha);
}

/**
 * Containment with an early exit: true when `old` is reachable from `new` (or equal). Unlike
 * `ancestors` it stops the walk the moment `old` is seen — the fast-forward path in receive-pack
 * asks exactly this question, and the pushed commit's parent usually is the answer one step in.
 */
export function isAncestorEarlyExit(repo: Repo, oldSha: string, newSha: string): boolean {
  if (oldSha === newSha) return true;
  const seen = new Set<string>();
  const stack = [newSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === oldSha) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = readCommit(repo, sha);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return false;
}

export type TreeDiffEntry = { path: string; status: 'added' | 'removed' | 'modified'; oldSha: string | null; newSha: string | null; additions: number; deletions: number };

/** Diff two trees' flat maps into GitHub-style file entries. */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string): TreeDiffEntry[] {
  const base = baseTree ? flattenTree(repo, baseTree) : new Map<string, { sha: string; mode: string }>();
  const head = flattenTree(repo, headTree);
  const out: TreeDiffEntry[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) {
      out.push({ path, status: 'added', oldSha: null, newSha: entry.sha, additions: lineCount(repo, entry.sha), deletions: 0 });
    } else if (old.sha !== entry.sha) {
      const b = blobText(repo, old.sha).split('\n').length;
      const h = blobText(repo, entry.sha).split('\n').length;
      const common = Math.min(b, h);
      out.push({ path, status: 'modified', oldSha: old.sha, newSha: entry.sha, additions: Math.max(1, h - common), deletions: Math.max(0, b - common) });
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldSha: entry.sha, newSha: null, additions: 0, deletions: blobText(repo, entry.sha).split('\n').length });
  }
  return out;
}

function blobText(repo: Repo, sha: string): string {
  const obj = getObject(repo, sha);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

function lineCount(repo: Repo, sha: string): number {
  const text = blobText(repo, sha);
  if (text === '') return 0;
  return text.split('\n').length;
}

export type MergeResult = { ok: true; tree: string } | { ok: false; conflicts: string[] };

/** Three-way merge of two flat trees against an ancestor tree; per-path content merge. */
export function mergeTrees(repo: Repo, ancestor: Map<string, string> | null, ours: Map<string, string>, theirs: Map<string, string>): MergeResult {
  const paths = new Set<string>([...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, string>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const o = ours.get(path) ?? null;
    const t = theirs.get(path) ?? null;
    const a = ancestor?.get(path) ?? null;
    if (o === t) {
      if (o !== undefined) merged.set(path, o);
    } else if (o === a) {
      if (t !== undefined) merged.set(path, t);
    } else if (t === a) {
      if (o !== undefined) merged.set(path, o);
    } else {
      // Both sides changed differently: try a line-level union merge; refuse on overlap.
      const r = mergeFileLines(repo, a, o, t);
      if (r) merged.set(path, r);
      else conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, tree: buildTree(repo, merged) };
}

function blobBytes(repo: Repo, sha: string | null): Buffer | null {
  if (sha === null) return null;
  const obj = getObject(repo, sha);
  return obj && obj.type === 'blob' ? obj.data : null;
}

/** Line-level three-way merge; null when both sides touched the same line. */
function mergeFileLines(repo: Repo, aSha: string | null, oSha: string, tSha: string): string | null {
  const a = (blobBytes(repo, aSha) ?? Buffer.alloc(0)).toString('utf8').split('\n');
  const o = (blobBytes(repo, oSha) ?? Buffer.alloc(0)).toString('utf8').split('\n');
  const t = (blobBytes(repo, tSha) ?? Buffer.alloc(0)).toString('utf8').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < o.length || i < t.length) {
    const ol = o[i] ?? null;
    const tl = t[i] ?? null;
    const al = a[i] ?? null;
    if (ol === tl) {
      if (ol !== null) out.push(ol);
    } else if (ol === al) {
      if (tl !== null) out.push(tl);
    } else if (tl === al) {
      if (ol !== null) out.push(ol);
    } else {
      return null; // same line changed on both sides
    }
    i += 1;
  }
  return out.join('\n');
}

/** The empty tree's well-known sha (git's canonical 4b825dc...). */
export const EMPTY_TREE_SHA = sha1Of('tree', encodeTree([]));
