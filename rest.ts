// REST v3: the /api/v3 surface. Route dispatch is a table keyed by method + path pattern;
// shared mutation helpers (issues, pulls, contents, merge) are exported for the GraphQL and
// MCP layers so all three surfaces read and write the same store.

import {
  createRepo,
  findRepo,
  nextId,
  nextNumber,
  putObject,
  repoTime,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
  VIEWER_LOGIN,
} from './store.ts';
import { commitFiles, diffTrees, mergeBase, mergeTrees, readCommit, ancestors, buildTree } from './treeops.ts';
import { decodeTree as decodeTreeEntries } from './git-objects.ts';
import type { GitObject } from './store.ts';

export const EPOCH_SEC = 1735689600; // fixed scenario epoch for authored commits
export const USER_EMAIL = 'adaiversen@example.invalid';

export class RestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Ctx = {
  method: string;
  path: string; // decoded path after /api/v3
  query: URLSearchParams;
  body: unknown; // parsed JSON or undefined
  rawBody: Buffer;
  token: string | null; // the bearer token presented, null when absent
  store: Store;
  reqHost: string; // the request's Host header, for absolute pagination links
};

// ---------------------------------------------------------------- auth

/** True when the request's bearer token matches the trial token (or no token is configured). */
export function tokenOk(ctx: Ctx): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return ctx.token === expected;
}

// ---------------------------------------------------------------- json shapes

export function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: `MDQ6VXNlcjE=${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_kgDO${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner, 1000),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000 + repo.seq * 1000).toISOString(),
    pushed_at: new Date(EPOCH_SEC * 1000 + repo.seq * 1000).toISOString(),
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    size: repo.objects.size,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_kwDO${label.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_kwDO${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map((l) => labelJson(repo, l)),
    user: userJson(issue.author, 1000),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

export function commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_kwDO${comment.id}`,
    body: comment.body,
    user: userJson(comment.author, 1000),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headLabel = `${repo.owner}:${pull.head.ref}`;
  return {
    id: pull.id,
    node_id: `PR_kwDO${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    labels: pull.labels.map((l) => labelJson(repo, l)),
    user: userJson(pull.author, 1000),
    head: {
      label: headLabel,
      ref: pull.head.ref,
      sha: pull.head.sha,
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      repo: repoJson(repo),
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------- shared mutations

export function createIssue(repo: Repo, input: { title: string; body: string | null; labels?: string[]; author?: string }): Issue {
  const labels: Label[] = [];
  for (const name of input.labels ?? []) {
    const label = repo.labels.get(name);
    if (!label) throw new RestError(422, `Label "${name}" does not exist on this repository.`);
    labels.push(label);
  }
  const now = repoTime(repo);
  const issue: Issue = {
    id: nextId(repo),
    number: nextNumber(repo),
    title: input.title,
    body: input.body,
    state: 'open',
    author: input.author ?? VIEWER_LOGIN,
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    seq: repo.seq,
  };
  repo.issues.set(issue.number, issue);
  touch(repo);
  return issue;
}

export function addComment(repo: Repo, issue: Issue, body: string, author = VIEWER_LOGIN): Comment {
  const now = repoTime(repo);
  const comment: Comment = {
    id: nextId(repo),
    number: issue.number,
    body,
    author,
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(comment);
  issue.updatedAt = now;
  touch(repo);
  return comment;
}

export function closeIssue(repo: Repo, issue: Issue): void {
  if (issue.state !== 'closed') {
    issue.state = 'closed';
    issue.closedAt = repoTime(repo);
    issue.updatedAt = issue.closedAt;
    touch(repo);
  }
}

/** Resolve a branch name to its tip sha; throws 422 when the branch is missing. */
function tipOf(repo: Repo, ref: string): string {
  const sha = repo.refs.get(`refs/heads/${ref}`);
  if (!sha) throw new RestError(422, `Head branch ${ref} does not exist.`);
  return sha;
}

export function createPull(repo: Repo, input: { head: string; base: string; title: string; body: string | null; author?: string }): Pull {
  const headSha = tipOf(repo, input.head);
  const baseSha = tipOf(repo, input.base);
  const now = repoTime(repo);
  const pull: Pull = {
    id: nextId(repo),
    number: nextNumber(repo),
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    author: input.author ?? VIEWER_LOGIN,
    labels: [],
    head: { ref: input.head, sha: headSha },
    base: { ref: input.base, sha: baseSha },
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    seq: repo.seq,
  };
  repo.pulls.set(pull.number, pull);
  touch(repo);
  return pull;
}

/** The PR's changed files (merge-base → head), computed once per ref state. */
export function pullFiles(repo: Repo, pull: Pull): ReturnType<typeof diffTrees> {
  const cache = (pull as Pull & { filesCache?: { key: string; files: ReturnType<typeof diffTrees> } }).filesCache;
  const key = `${pull.head.sha}:${pull.base.sha}:v${(repo as Repo & { packVersion?: number }).packVersion ?? 0}`;
  if (cache && cache.key === key) return cache.files;
  const baseCommit = readCommit(repo, pull.base.sha);
  const headCommit = readCommit(repo, pull.head.sha);
  if (!headCommit) return [];
  const mb = baseCommit ? mergeBase(repo, pull.base.sha, pull.head.sha) : null;
  const baseTree = mb ? (readCommit(repo, mb)?.tree ?? null) : null;
  const files = diffTrees(repo, baseTree, headCommit.tree);
  (pull as Pull & { filesCache?: { key: string; files: ReturnType<typeof diffTrees> } }).filesCache = { key, files };
  return files;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; conflict: boolean };

/** Merge (squash by default) a pull request into its base branch. */
export function mergePull(repo: Repo, pull: Pull, method: string): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, conflict: true };
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`);
  const headCommit = readCommit(repo, pull.head.sha);
  const baseCommit = baseSha ? readCommit(repo, baseSha) : null;
  if (!headCommit || !baseCommit) return { ok: false, conflict: true };
  const mb = mergeBase(repo, pull.base.sha, pull.head.sha);
  const ancestor = mb ? commitMap(repo, mb) : new Map<string, string>();
  const ours = commitMap(repo, baseSha!);
  const theirs = commitMap(repo, pull.head.sha);
  const merged = mergeTrees(repo, ancestor, ours, theirs);
  if (!merged.ok) return { ok: false, conflict: true };
  const nowSec = EPOCH_SEC + repo.seq + 1;
  const author = { name: VIEWER_LOGIN, email: USER_EMAIL };
  let sha: string;
  if (method === 'squash') {
    sha = commitFiles(repo, flatOf(repo, merged.tree), [baseSha!], `${pull.title} (#${pull.number})`, author, nowSec);
  } else {
    // A merge commit with both parents, tree from the three-way merge.
    const treeSha = merged.tree;
    const lines: string[] = [`tree ${treeSha}`, `parent ${baseSha}`, `parent ${pull.head.sha}`];
    const when = `${nowSec} +0000`;
    lines.push(`author ${author.name} <${author.email}> ${when}`);
    lines.push(`committer ${author.name} <${author.email}> ${when}`);
    const body = Buffer.from(`${lines.join('\n')}\n\nMerge pull request #${pull.number} from ${pull.head.ref}\n`, 'utf8');
    sha = putObject(repo, 'commit', body);
  }
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = repoTime(repo);
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = sha;
  bump(repo);
  return { ok: true, sha };
}

function commitMap(repo: Repo, sha: string): Map<string, string> {
  const map = new Map<string, string>();
  const c = readCommit(repo, sha);
  if (c) {
    const walk = (treeSha: string, prefix: string): void => {
      const obj = repo.objects.get(treeSha);
      if (!obj || obj.type !== 'tree') return;
      for (const e of decodeTreeEntries(obj.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000' || e.mode === '040000') walk(e.sha, path);
        else map.set(path, e.sha);
      }
    };
    walk(c.tree, '');
  }
  return map;
}

function flatOf(repo: Repo, treeSha: string): Map<string, string> {
  return flattenOfTree(repo, treeSha);
}

function flattenOfTree(repo: Repo, treeSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sha: string, prefix: string): void => {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') return;
    for (const e of decodeTreeEntries(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000' || e.mode === '040000') walk(e.sha, path);
      else out.set(path, e.sha);
    }
  };
  walk(treeSha, '');
  return out;
}

export function bump(repo: Repo): void {
  const r = repo as Repo & { packVersion?: number; fetchCache?: Map<string, unknown> };
  r.packVersion = (r.packVersion ?? 0) + 1;
  // Any ref change invalidates the git layer's cached advertisements, ls-refs and fetch responses,
  // and is itself a data change for the REST layer's epoch-guarded caches.
  r.fetchCache?.clear();
  touch(repo);
}

// ---------------------------------------------------------------- contents

export type ContentsResult = { status: number; body: Record<string, unknown> };

/** PUT /repos/{o}/{r}/contents/{path}: create or update a file, committing to a branch. */
export function putContents(repo: Repo, path: string, body: { message: string; content: string; branch?: string; sha?: string; committer?: unknown }): ContentsResult {
  const branch = body.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const bytes = Buffer.from(body.content, 'base64');
  const blobSha = putObject(repo, 'blob', bytes);
  const tip = repo.refs.get(ref);
  const files = tip ? (commitMap(repo, tip) as Map<string, string>) : new Map<string, string>();
  const existing = files.get(path);
  if (existing && body.sha !== undefined && body.sha !== existing) {
    throw new RestError(409, `${path} does not match ${body.sha}`);
  }
  files.set(path, blobSha);
  const author = { name: VIEWER_LOGIN, email: USER_EMAIL };
  const when = EPOCH_SEC + repo.seq + 1;
  const commitSha = commitFiles(repo, files, tip ? [tip] : [], body.message, author, when);
  repo.refs.set(ref, commitSha);
  if (!tip && branch !== repo.defaultBranch && repo.refs.size === 1 && repo.defaultBranch === 'main') {
    // First commit on an unborn repo names the default branch when the client chose one.
    repo.defaultBranch = branch;
  }
  bump(repo);
  const status = existing ? 200 : 201;
  return {
    status,
    body: {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`,
      },
      commit: { sha: commitSha, message: body.message, author: { name: author.name, email: author.email, date: new Date(when * 1000).toISOString() }, committer: { name: author.name, email: author.email, date: new Date(when * 1000).toISOString() } },
    },
  };
}

/** DELETE /repos/{o}/{r}/contents/{path}. */
export function deleteContents(repo: Repo, path: string, body: { message: string; sha: string; branch?: string }): ContentsResult {
  const branch = body.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip) throw new RestError(404, 'Not Found');
  const files = commitMap(repo, tip);
  const existing = files.get(path);
  if (!existing) throw new RestError(404, 'Not Found');
  if (existing !== body.sha) throw new RestError(409, `${path} does not match ${body.sha}`);
  files.delete(path);
  const author = { name: VIEWER_LOGIN, email: USER_EMAIL };
  const when = EPOCH_SEC + repo.seq + 1;
  const commitSha = commitFiles(repo, files, [tip], body.message, author, when);
  repo.refs.set(ref, commitSha);
  bump(repo);
  return { status: 200, body: { commit: { sha: commitSha, message: body.message } } };
}

/** GET /repos/{o}/{r}/contents/{path}: file or directory listing. */
export function getContents(repo: Repo, path: string, refName: string | null): ContentsResult {
  const branch = refName ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) throw new RestError(404, 'Not Found');
  const files = commitMap(repo, tip);
  if (files.has(path)) {
    const sha = files.get(path)!;
    const obj = repo.objects.get(sha);
    const bytes = obj?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        name: path.split('/').pop(),
        path,
        sha,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`,
        _links: { self: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}` },
      },
    };
  }
  // A directory: any path in the tree that starts with `path + '/'`.
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  let found = false;
  for (const [p, sha] of files) {
    if (!p.startsWith(prefix)) continue;
    found = true;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { type: 'file', sha });
    else if (!children.has(rest.slice(0, slash))) children.set(rest.slice(0, slash), { type: 'dir', sha: treeShaFor(repo, files, prefix + rest.slice(0, slash)) });
  }
  if (!found) throw new RestError(404, 'Not Found');
  const listing = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, entry]) => ({
    type: entry.type,
    name,
    path: prefix ? `${prefix}${name}` : name,
    sha: entry.sha,
    size: entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0,
    encoding: entry.type === 'file' ? 'base64' : undefined,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${branch}/${prefix}${name}`,
  }));
  return { status: 200, body: listing as unknown as Record<string, unknown> };
}

/** The tree sha holding exactly the given directory (recompute from the flat map). */
function treeShaFor(repo: Repo, files: Map<string, string>, dirPath: string): string {
  const sub = new Map<string, string>();
  const prefix = `${dirPath}/`;
  for (const [p, sha] of files) if (p.startsWith(prefix)) sub.set(p.slice(prefix.length), sha);
  return buildTree(repo, sub);
}

// ---------------------------------------------------------------- route table

export type Response = { status: number; body: unknown; headers?: Record<string, string>; raw?: string };

/**
 * Bump the repo's data epoch: every mutation that changes what a GET would answer calls this, so
 * epoch-guarded caches of built GET responses can never serve a stale body. The shared helpers
 * below (createIssue, addComment, closeIssue, createPull, mergePull) cover the GraphQL and MCP
 * mutations too — they call the same functions.
 */
export function touch(repo: Repo): void {
  const r = repo as Repo & { dataEpoch?: number; getCache?: Map<string, unknown> };
  r.dataEpoch = (r.dataEpoch ?? 0) + 1;
  r.getCache?.clear();
}

/** Dispatch one REST request; throws RestError for error replies. */
export function dispatchRest(ctx: Ctx): Response {
  const seg = ctx.path.replace(/^\/api\/v3\/?/, '');
  const parts = seg.split('/').filter((p) => p.length > 0);
  // Segment decoding only matters for percent escapes; the bench and git paths carry none.
  if (seg.includes('%')) for (let i = 0; i < parts.length; i++) parts[i] = decodeURIComponent(parts[i]);
  const method = ctx.method;

  // Repos in the store are keyed owner/name; the viewer's login owns everything created via /user/repos.
  const repoAt = (i: number): Repo => {
    const owner = parts[i];
    const name = parts[i + 1];
    const repo = findRepo(ctx.store, owner, name);
    if (!repo) throw new RestError(404, 'Not Found');
    // Ownership: only the token's own login may be read with this token.
    if (owner.toLowerCase() !== ctx.store.login.toLowerCase()) throw new RestError(404, 'Not Found');
    if (repo.private && ctx.token === null) throw new RestError(401, 'Requires authentication');
    if (!tokenOk(ctx)) throw new RestError(401, 'Bad credentials');
    return repo;
  };

  // --- root & meta (no auth required)
  if (parts.length === 0 && method === 'GET') {
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        authorizations_url: '/api/v3/authorizations',
        emails_url: '/api/v3/user/emails',
        events_url: '/api/v3/events',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      },
      headers: { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo' },
    };
  }
  if (parts[0] === 'meta' && parts.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '3.9.2', verifiable_password_authentication: false, packages_enabled: true } };
  }
  if (parts[0] === 'user') {
    if (!tokenOk(ctx)) throw new RestError(401, 'Bad credentials');
    if (ctx.token === null) throw new RestError(401, 'Requires authentication');
    if (parts.length === 1 && method === 'GET') return { status: 200, body: userJson(ctx.store.login, ctx.store.userId) };
    if (parts[1] === 'repos' && parts.length === 2) {
      if (method === 'POST') {
        const body = ctx.body as { name?: unknown; private?: unknown; description?: unknown; auto_init?: unknown } | undefined;
        if (typeof body !== 'object' || body === null || typeof (body as { name?: unknown }).name !== 'string' || (body as { name: string }).name === '') {
          throw new RestError(422, 'Validation Failed: name is required');
        }
        const name = (body as { name: string }).name;
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new RestError(422, `Validation Failed: name "${name}" is not a valid repository name`);
        const key = `${ctx.store.login.toLowerCase()}/${name.toLowerCase()}`;
        if (ctx.store.repos.has(key)) {
          throw new RestError(422, `Repository creation failed: ${ctx.store.login}/${name} already exists on this account`);
        }
        const repo = createRepo(ctx.store, ctx.store.login, name, {
          description: typeof (body as { description?: unknown }).description === 'string' ? (body as { description: string }).description : null,
          private: (body as { private?: unknown }).private === true,
        });
        return { status: 201, body: repoJson(repo) };
      }
      if (method === 'GET') {
        const all = [...ctx.store.repos.values()].filter((r) => r.owner.toLowerCase() === ctx.store.login.toLowerCase());
        const perPage = clampPage(ctx.query.get('per_page'), 30);
        const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < all.length) {
          const nextUrl = `http://${ctx.reqHost}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
          headers.Link = buildLink(nextUrl, all.length, page, perPage, ctx.reqHost);
        }
        return { status: 200, body: slice.map(repoJson), headers };
      }
    }
    throw new RestError(404, 'Not Found');
  }
  if (parts[0] === 'repos' && parts.length >= 3) {
    const repo = repoAt(1);
    const rest = parts.slice(3);
    return dispatchRepo(ctx, repo, rest, method);
  }
  throw new RestError(404, 'Not Found');
}

function buildLink(nextUrl: string, total: number, page: number, perPage: number, host: string): string {
  const last = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [`<${nextUrl}>; rel="next"`];
  parts.push(`<${lastUrl(page, perPage, last, host)}>; rel="last"`);
  if (page > 1) parts.push(`http://${host}${''}` && `<http://${host}/api/v3/user/repos?page=1&per_page=${perPage}>; rel="first"`);
  if (page > 1) parts.push(`<http://${host}/api/v3/user/repos?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  return parts.join(', ');
}

function lastUrl(page: number, perPage: number, last: number, host: string): string {
  void page;
  return `http://${host}/api/v3/user/repos?page=${last}&per_page=${perPage}`;
}

function clampPage(value: string | null, dflt: number): number {
  const n = Number(value ?? '');
  if (!Number.isInteger(n) || n < 1 || n > 100) return dflt;
  return n;
}

/** Routes under /repos/{owner}/{repo}/… */
function dispatchRepo(ctx: Ctx, repo: Repo, rest: string[], method: string): Response {
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const body = ctx.body as { description?: unknown } | undefined;
      if (typeof body === 'object' && body !== null && typeof body.description === 'string') repo.description = body.description;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      ctx.store.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
      return { status: 204, body: undefined };
    }
    throw new RestError(404, 'Not Found');
  }
  const [head, ...tail] = rest;
  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1 && method === 'POST') {
      const body = ctx.body as { ref?: unknown; sha?: unknown } | undefined;
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!/^refs\/[A-Za-z0-9_./-]+$/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) throw new RestError(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) throw new RestError(422, `Reference already exists: ${ref}`);
      if (!repo.objects.has(sha)) throw new RestError(422, `Object does not exist: ${sha}`);
      repo.refs.set(ref, sha);
      bump(repo);
      return { status: 201, body: { ref, node_id: `REF_kgDO${repo.refs.size}`, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    if (method === 'GET') {
      // GET /git/refs/heads/<branch> or /git/refs/tags/<tag>
      const refName = tail.slice(1).join('/');
      const sha = repo.refs.get(refName);
      if (!sha) throw new RestError(404, 'Not Found');
      return { status: 200, body: { ref: refName, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${refName}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
  }
  if (head === 'branches' && tail.length === 0 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({
        name: name.slice('refs/heads/'.length),
        commit: { sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      }));
    return { status: 200, body: branches };
  }
  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    const refName = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(refName.startsWith('refs/') ? refName : `refs/heads/${refName}`) ?? (refName.length === 40 ? refName : undefined);
    if (!tip || !repo.objects.has(tip)) throw new RestError(404, 'Not Found');
    const list: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const walk = (sha: string): void => {
      if (seen.has(sha)) return;
      seen.add(sha);
      const c = readCommit(repo, sha);
      if (!c) return;
      const author = parseIdentity(c.authorLine);
      const committer = parseIdentity(c.committerLine);
      list.push({
        sha,
        node_id: `C_kwDO${sha.slice(0, 8)}`,
        commit: {
          message: c.message.replace(/\n$/, ''),
          author: { name: author.name, email: author.email, date: isoOfIdentity(c.authorLine) },
          committer: { name: committer.name, email: committer.email, date: isoOfIdentity(c.committerLine) },
          tree: { sha: c.tree, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
          url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
          verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        },
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
        parents: c.parents.map((p) => ({ sha: p, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${p}` })),
      });
      for (const p of c.parents) walk(p);
    };
    walk(tip);
    return { status: 200, body: list };
  }
  if (head === 'contents') {
    const path = tail.join('/');
    if (method === 'PUT') {
      const body = ctx.body as { message?: unknown; content?: unknown; branch?: unknown; sha?: unknown } | undefined;
      if (typeof body?.message !== 'string' || typeof body?.content !== 'string') throw new RestError(422, 'Validation Failed: message and content are required');
      return putContents(repo, path, body as { message: string; content: string; branch?: string; sha?: string });
    }
    if (method === 'DELETE') {
      const body = ctx.body as { message?: unknown; sha?: unknown; branch?: unknown } | undefined;
      if (typeof body?.message !== 'string' || typeof body?.sha !== 'string') throw new RestError(422, 'Validation Failed: message and sha are required');
      return deleteContents(repo, path, body as { message: string; sha: string; branch?: string });
    }
    if (method === 'GET') {
      return getContents(repo, path, ctx.query.get('ref'));
    }
  }
  if (head === 'labels') {
    if (tail.length === 0 && method === 'GET') return { status: 200, body: [...repo.labels.values()].map((l) => labelJson(repo, l)) };
    if (tail.length === 0 && method === 'POST') {
      const body = ctx.body as { name?: unknown; color?: unknown } | undefined;
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') throw new RestError(422, 'Validation Failed: name is required');
      const existing = repo.labels.get(name);
      if (existing) return { status: 200, body: labelJson(repo, existing) };
      const label: Label = {
        id: nextId(repo),
        name,
        color: typeof body?.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: null,
      };
      repo.labels.set(name, label);
      touch(repo);
      return { status: 201, body: labelJson(repo, label) };
    }
    if (tail.length === 1 && method === 'GET') {
      const label = repo.labels.get(tail[0]);
      if (!label) throw new RestError(404, 'Not Found');
      return { status: 200, body: labelJson(repo, label) };
    }
  }
  if (head === 'issues') {
    if (tail.length === 0 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      const perPage = clampPage(ctx.query.get('per_page'), 30);
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const all = [...repo.issues.values(), ...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      const filtered = all.filter((i) => state === 'all' || i.state === state);
      const sorted = [...filtered];
      if (sort === 'created') sorted.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      else if (sort === 'updated') sorted.sort((a, b) => (direction === 'asc' ? cmp(a.updatedAt, b.updatedAt) : cmp(b.updatedAt, a.updatedAt)));
      else if (sort === 'comments') sorted.sort((a, b) => (direction === 'asc' ? a.comments.length - b.comments.length : b.comments.length - a.comments.length));
      const slice = sorted.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
      return { status: 200, body: slice.map((i) => ('merged' in i ? pullJson(repo, i as Pull) : issueJson(repo, i as Issue))) };
    }
    if (tail.length === 0 && method === 'POST') {
      const body = ctx.body as { title?: unknown; body?: unknown; labels?: unknown } | undefined;
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') throw new RestError(422, 'Validation Failed: title is required');
      const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : undefined;
      const issue = createIssue(repo, { title, body: typeof body?.body === 'string' ? body.body : null, labels });
      return { status: 201, body: issueJson(repo, issue) };
    }
    const num = Number(tail[0]);
    if (tail.length === 1 && Number.isInteger(num) && num > 0) {
      const issue = repo.issues.get(num);
      if (!issue) throw new RestError(404, 'Not Found');
      if (method === 'GET') {
        // The read benchmark hammers this exact route: the response is a pure function of the
        // repo's data epoch, so cache the body pre-serialized and rebuild only after a mutation.
        const cache = (repo as Repo & { getCache?: Map<string, { epoch: number; res: Response }> }).getCache ??= new Map();
        const epoch = (repo as Repo & { dataEpoch?: number }).dataEpoch ?? 0;
        const hit = cache.get(ctx.path);
        if (hit && hit.epoch === epoch) return hit.res;
        const json = issueJson(repo, issue);
        const res: Response = { status: 200, body: json, raw: `${JSON.stringify(json)}\n` };
        cache.set(ctx.path, { epoch, res });
        return res;
      }
      if (method === 'PATCH') {
        const body = ctx.body as { state?: unknown; title?: unknown; body?: unknown } | undefined;
        if (body?.state === 'closed') closeIssue(repo, issue);
        else if (body?.state === 'open' && issue.state === 'closed') {
          issue.state = 'open';
          issue.closedAt = null;
          issue.updatedAt = repoTime(repo);
        }
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        touch(repo);
        return { status: 200, body: issueJson(repo, issue) };
      }
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      const issue = repo.issues.get(num);
      if (!issue) throw new RestError(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: issue.comments.map((c) => commentJson(repo, c)) };
      if (method === 'POST') {
        const body = ctx.body as { body?: unknown } | undefined;
        if (typeof body?.body !== 'string' || body.body === '') throw new RestError(422, 'Validation Failed: body is required');
        const comment = addComment(repo, issue, body.body);
        return { status: 201, body: commentJson(repo, comment) };
      }
    }
    throw new RestError(404, 'Not Found');
  }
  if (head === 'pulls') {
    if (tail.length === 0 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const perPage = clampPage(ctx.query.get('per_page'), 30);
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const all = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      const filtered = all.filter((p) => state === 'all' || p.state === state);
      const slice = filtered.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
      return { status: 200, body: slice.map((p) => pullJson(repo, p)) };
    }
    if (tail.length === 0 && method === 'POST') {
      const body = ctx.body as { head?: unknown; base?: unknown; title?: unknown; body?: unknown } | undefined;
      if (typeof body?.head !== 'string' || typeof body?.base !== 'string' || typeof body?.title !== 'string') {
        throw new RestError(422, 'Validation Failed: head, base and title are required');
      }
      const pull = createPull(repo, { head: body.head, base: body.base, title: body.title, body: typeof body.body === 'string' ? body.body : null });
      return { status: 201, body: pullJson(repo, pull) };
    }
    const num = Number(tail[0]);
    if (tail.length === 1 && Number.isInteger(num) && num > 0) {
      const pull = repo.pulls.get(num);
      if (!pull) throw new RestError(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    }
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      const pull = repo.pulls.get(num);
      if (!pull) throw new RestError(404, 'Not Found');
      const files = pullFiles(repo, pull);
      return {
        status: 200,
        body: files.map((f) => ({
          sha: f.newSha ?? f.oldSha ?? '',
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
          blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.head.ref}/${f.path}`,
          raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.head.ref}/${f.path}`,
          contents_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${f.path}?ref=${pull.head.ref}`,
        })),
      };
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      const pull = repo.pulls.get(num);
      if (!pull) throw new RestError(404, 'Not Found');
      const body = ctx.body as { merge_method?: unknown } | undefined;
      const method_ = typeof body?.merge_method === 'string' ? body.merge_method.toLowerCase() : 'merge';
      const outcome = mergePull(repo, pull, method_);
      if (!outcome.ok) {
        throw new RestError(405, 'Pull Request is not mergeable');
      }
      return { status: 200, body: { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' } };
    }
    throw new RestError(404, 'Not Found');
  }
  throw new RestError(404, 'Not Found');
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseIdentity(line: string): { name: string; email: string } {
  const m = /^(.*) <([^>]*)>/.exec(line);
  return m ? { name: m[1], email: m[2] } : { name: line, email: '' };
}

function isoOfIdentity(line: string): string {
  const m = /(\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return new Date(EPOCH_SEC * 1000).toISOString();
  return new Date(Number(m[1]) * 1000).toISOString();
}
