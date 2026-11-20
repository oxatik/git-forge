// The forge's own store: repositories, refs, git objects, issues, labels, comments, pulls.
// Everything lives in memory in one process; every identity and timestamp is derived from the
// state itself, so two runs over the same request sequence behave identically.
//
// Git objects are content-addressed with SHA-1 over the canonical loose encoding
//   "<type> <byte-length>\0<bytes>"  — the same hash git and every forge uses.

/** A git object's bytes with its canonical type. */
export type GitObject = { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer };

/** One label: GitHub exposes id as a number and color without the leading '#'. */
export type Label = { id: number; name: string; color: string; description: string | null };

/** One issue comment. */
export type Comment = {
  id: number;
  number: number; // the issue/pull it belongs to
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

/** One issue. Numbers share one counter with pulls (as on GitHub). */
export type Issue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  author: string;
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  seq: number; // creation order, for stable sorting
};

/** One file a pull request changed, as the REST pulls/files endpoint returns it. */
export type PullFile = {
  sha: string; // the blob sha of the file's new content
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
};

/** One pull request. */
export type Pull = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  author: string;
  labels: Label[];
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  seq: number; // creation order, for stable sorting
};

/** One repository: refs, objects, issues, pulls and the counters that keep identities stable. */
export type Repo = {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  refs: Map<string, string>; // 'refs/heads/x' | 'refs/tags/y' -> sha
  objects: Map<string, GitObject>; // sha -> object
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextObjectId: number; // database id for issues/pulls/comments/labels
  nextNumber: number; // shared issue/pull number space, starts at 1
  seq: number; // deterministic clock: advanced per write (1 second per step)
};

export type Store = {
  login: string;
  userId: number;
  repos: Map<string, Repo>; // key: lowercase owner/lowercase name
  nextRepoId: number;
  nextLabelId: number;
};

export const VIEWER_LOGIN = 'adaiversen';

export function newStore(): Store {
  return {
    login: VIEWER_LOGIN,
    userId: 1000,
    repos: new Map(),
    nextRepoId: 5000,
    nextLabelId: 1,
  };
}

/** The canonical key for a repo path. */
export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

const CLOCK_BASE = Date.parse('2026-11-01T00:00:00Z');

/** One deterministic step of the repo's clock: 1 second per write, never a wall clock. */
export function repoTime(repo: Repo): string {
  repo.seq += 1;
  return new Date(CLOCK_BASE + repo.seq * 1000).toISOString();
}

/** SHA-1 of a canonical loose object. */
export function objectSha(type: GitObject['type'], data: Buffer): string {
  return sha1Loose(type, data.length, data);
}

import { createHash } from 'node:crypto';

/** SHA-1 over the loose object encoding, exposed for the git layer. */
export function sha1Loose(type: string, size: number, data: Buffer): string {
  const header = Buffer.from(`${type} ${size}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object if absent; returns its sha. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const sha = objectSha(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** Create a repo in the store; the caller has already validated the name. */
export function createRepo(store: Store, owner: string, name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string } = {}): Repo {
  const repo: Repo = {
    id: store.nextRepoId++,
    owner,
    name,
    private: opts.private ?? false,
    description: opts.description ?? null,
    defaultBranch: opts.defaultBranch ?? 'main',
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextObjectId: 1,
    nextNumber: 1,
    seq: 0,
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

export function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

/** A new database id for the repo (issues, pulls, comments, labels). */
export function nextId(repo: Repo): number {
  return repo.nextObjectId++;
}

/** The next free issue/pull number (one shared sequence, as GitHub does). */
export function nextNumber(repo: Repo): number {
  return repo.nextNumber++;
}

/** Opaque GraphQL-style global id for a database row. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'Comment' | 'User', dbId: number): string {
  return `0f6:${kind}${dbId}`;
}

/** Decode a global id; null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; dbId: number } | null {
  const m = /^0f6:([A-Za-z]+)(\d+)$/.exec(id);
  if (!m) return null;
  return { kind: m[1], dbId: Number(m[2]) };
}
