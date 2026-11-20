// GraphQL v4: POST /api/graphql. The suite's 18 documents use a small slice of GraphQL —
// named query/mutation operations, variables, aliases, literal arguments (Int/String/enum/
// list/input object/null), one inline type-conditioned fragment, __type and node(id:) — and
// this parser+executor covers exactly that slice over the store.

import { globalId, decodeGlobalId, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { addComment, closeIssue, createIssue, createPull, mergePull, pullFiles, tokenOk, type Ctx } from './rest.ts';
import { mergeBase, mergeTrees, readCommit } from './treeops.ts';
import { decodeTree, type TreeEntry } from './git-objects.ts';
import type { GitObject } from './store.ts';

export type GraphqlEnvelope = { data?: Record<string, unknown> | null; errors?: Array<{ message: string }> };

class GraphqlSyntaxError extends Error {}
class GraphqlFieldError extends Error {}

// ---------------------------------------------------------------- tokenizer

type Token = { kind: 'name' | 'int' | 'string' | 'punct'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const n = src[j + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : n;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new GraphqlSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (c === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: c });
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

type FieldSel = { kind: 'field'; name: string; alias: string | null; args: Array<{ name: string; value: Value }>; selection: FieldSel[] | null };
type FragmentSel = { kind: 'fragment'; typeCondition: string; selection: FieldSel[] };
type Selection = FieldSel | FragmentSel;
type Operation = { type: 'query' | 'mutation'; name: string; selection: FieldSel[] };

class Parser {
  private i = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private next(): Token {
    const t = this.tokens[this.i++];
    if (!t) throw new GraphqlSyntaxError('unexpected end of document');
    return t;
  }

  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new GraphqlSyntaxError(`expected ${value}, got ${t.value}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) {
      const t = this.next();
      if (t.kind !== 'name' || (t.value !== 'query' && t.value !== 'mutation')) {
        throw new GraphqlSyntaxError(`expected query or mutation, got ${t.value}`);
      }
      const type = t.value as 'query' | 'mutation';
      if (this.peek() && this.peek()!.kind === 'name' && this.peek()!.value !== '(') this.next(); // operation name (unused; one op per document)
      if (this.peek()?.value === '(') {
        this.expect('(');
        while (this.peek()?.value !== ')') {
          this.expect('$');
          this.next(); // variable name
          this.expect(':');
          this.parseType();
          if (this.peek()?.value === '=') {
            this.next();
            this.parseValue();
          }
        }
        this.expect(')');
      }
      while (this.peek()?.value === '@') {
        this.next();
        if (this.peek()?.value === '(') this.parseArguments();
      }
      const selection = this.parseSelectionSet();
      ops.push({ type, name: '', selection });
    }
    return ops;
  }

  private parseType(): string {
    let t = this.next().value;
    if (t === '[') {
      t = `${this.next().value}[]`;
      this.expect(']');
    }
    if (this.peek()?.value === '!') this.next();
    return t;
  }

  private parseSelectionSet(): FieldSel[] {
    this.expect('{');
    const out: FieldSel[] = [];
    while (this.peek()?.value !== '}') {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '.') {
        this.expect('.');
        this.expect('.');
        this.expect('on');
        const condition = this.next().value;
        while (this.peek()?.value === '@') {
          this.next();
          if (this.peek()?.value === '(') this.parseArguments();
        }
        const selection = this.parseSelectionSet();
        out.push({ kind: 'field', name: `\u0000fragment:${condition}`, alias: null, args: [], selection });
        continue;
      }
      if (t.kind !== 'name') throw new GraphqlSyntaxError(`expected field name, got ${t.value}`);
      let alias: string | null = null;
      let name = t.value;
      if (this.peek()?.value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = this.peek()?.value === '(' ? this.parseArguments() : [];
      while (this.peek()?.value === '@') {
        this.next();
        if (this.peek()?.value === '(') this.parseArguments();
      }
      const selection = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
      out.push({ kind: 'field', name, alias, args, selection });
    }
    this.expect('}');
    return out;
  }

  private parseArguments(): Array<{ name: string; value: Value }> {
    this.expect('(');
    const args: Array<{ name: string; value: Value }> = [];
    while (this.peek()?.value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'var', name: this.next().value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek()?.value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'lit', value: t.value };
    if (t.kind === 'int') return { kind: 'lit', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'lit', value: true };
      if (t.value === 'false') return { kind: 'lit', value: false };
      if (t.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'lit', value: `enum:${t.value}` };
    }
    throw new GraphqlSyntaxError(`unexpected token ${t.value}`);
  }
}

function evalValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': {
      if (!(v.name in variables)) throw new GraphqlFieldError(`Variable $${v.name} is undefined`);
      return variables[v.name];
    }
    case 'lit': {
      if (typeof v.value === 'string' && v.value.startsWith('enum:')) return v.value.slice(5);
      return v.value;
    }
    case 'list':
      return v.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function argMap(sel: FieldSel, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergedAt', 'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid', 'mergeable', 'mergeStateStatus', 'files', 'author', 'labels', 'body', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

type Node =
  | { type: 'queryRoot' }
  | { type: 'mutationRoot' }
  | { type: 'viewer' }
  | { type: 'user'; login: string }
  | { type: 'repository'; repo: Repo }
  | { type: 'issue'; repo: Repo; issue: Issue }
  | { type: 'pullRequest'; repo: Repo; pull: Pull }
  | { type: 'payload'; issue?: { repo: Repo; issue: Issue }; pull?: { repo: Repo; pull: Pull }; comment?: { id: number; body: string } }
  | { type: 'commentEdge'; comment: { id: number; body: string } }
  | { type: 'comment'; comment: { id: number; body: string } }
  | { type: 'ref'; name: string }
  | { type: 'changedFile'; path: string }
  | { type: 'type'; name: string };

type ExecCtx = { store: Store };

function typeNameOf(node: Node): string {
  switch (node.type) {
    case 'viewer':
    case 'user':
      return 'User';
    case 'repository':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pullRequest':
      return 'PullRequest';
    case 'payload':
      return 'Payload';
    case 'commentEdge':
      return 'CommentEdge';
    case 'comment':
      return 'IssueComment';
    case 'ref':
      return 'Ref';
    case 'changedFile':
      return 'PullRequestChangedFile';
    case 'type':
      return '__Type';
    default:
      return '';
  }
}

type Connection = { __connection: true; items: Array<Node | null>; pageInfo: { hasNextPage: boolean; endCursor: string }; paths?: string[] };

function paginate<T>(items: T[], first: unknown, after: unknown): { page: T[]; hasNextPage: boolean; endCursor: string } {
  const size = typeof first === 'number' && Number.isFinite(first) && first > 0 ? first : items.length;
  const offset = typeof after === 'string' && after.startsWith('cursor:') ? Number(after.slice(7)) : 0;
  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const page = items.slice(start, start + size);
  return { page, hasNextPage: start + size < items.length, endCursor: `cursor:${start + page.length}` };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Connection {
  const states = Array.isArray(args.states) ? (args.states as string[]).map((s) => String(s).toLowerCase()) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  let list = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
  if (states && states.length > 0) list = list.filter((i) => states.includes(i.state));
  if ((orderBy.direction ?? 'ASC') === 'DESC') list.reverse();
  const { page, hasNextPage, endCursor } = paginate(list, args.first, args.after);
  return {
    __connection: true,
    items: page.map((issue) => ({ type: 'issue', repo, issue } as Node)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Connection {
  const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
  const { page, hasNextPage, endCursor } = paginate(list, args.first, args.after);
  return {
    __connection: true,
    items: page.map((pull) => ({ type: 'pullRequest', repo, pull } as Node)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Connection {
  const files = pullFiles(repo, pull).map((f) => f.path);
  const { page, hasNextPage, endCursor } = paginate(files, args.first, args.after);
  return { __connection: true, items: page.map((p) => ({ type: 'changedFile', path: p } as Node)), pageInfo: { hasNextPage, endCursor } };
}

function computeMergeable(repo: Repo, pull: Pull): string {
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`);
  const headCommit = readCommit(repo, pull.head.sha);
  if (!baseSha || !headCommit) return 'UNKNOWN';
  const mb = mergeBase(repo, baseSha, pull.head.sha);
  const merged = mergeTrees(repo, mb ? flatMapOf(repo, mb) : new Map(), flatMapOf(repo, baseSha), flatMapOf(repo, pull.head.sha));
  return merged.ok ? 'MERGEABLE' : 'CONFLICTING';
}

function flatMapOf(repo: Repo, sha: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (treeSha: string, prefix: string): void => {
    const obj: GitObject | undefined = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return;
    for (const e of decodeTree(obj.data) as TreeEntry[]) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000' || e.mode === '040000') walk(e.sha, path);
      else map.set(path, e.sha);
    }
  };
  const c = readCommit(repo, sha);
  if (c) walk(c.tree, '');
  return map;
}

/** Resolve one field against a node. Throws GraphqlFieldError for unknown fields. */
function resolveField(node: Node, sel: FieldSel, variables: Record<string, unknown>, ctx: ExecCtx): { value?: unknown; node: Node | null; connection?: Connection } {
  const args = argMap(sel, variables);
  const name = sel.name;
  switch (node.type) {
    case 'viewer': {
      if (name === 'login') return { value: ctx.store.login, node: null };
      break;
    }
    case 'user': {
      if (name === 'login') return { value: node.login, node: null };
      if (name === 'id') return { value: globalId('User', 1000), node: null };
      if (name === 'name') return { value: 'ada iversen', node: null };
      if (name === 'email') return { value: 'adaiversen@example.invalid', node: null };
      if (name === 'url') return { value: `https://github.com/${node.login}`, node: null };
      break;
    }
    case 'repository': {
      const repo = node.repo;
      if (name === 'id') return { value: globalId('Repository', repo.id), node: null };
      if (name === 'databaseId') return { value: repo.id, node: null };
      if (name === 'name') return { value: repo.name, node: null };
      if (name === 'nameWithOwner') return { value: `${repo.owner}/${repo.name}`, node: null };
      if (name === 'owner') return { node: { type: 'user', login: repo.owner } };
      if (name === 'description') return { value: repo.description, node: null };
      if (name === 'defaultBranchRef') return { node: { type: 'ref', name: repo.defaultBranch } };
      if (name === 'viewerPermission') return { value: 'ADMIN', node: null };
      if (name === 'hasIssuesEnabled') return { value: true, node: null };
      if (name === 'isPrivate') return { value: repo.private, node: null };
      if (name === 'url') return { value: `https://github.com/${repo.owner}/${repo.name}`, node: null };
      if (name === 'ref') {
        const refName = typeof args.name === 'string' ? args.name : '';
        const sha = repo.refs.get(refName.startsWith('refs/') ? refName : `refs/heads/${refName}`);
        return sha ? { node: { type: 'ref', name: refName } } : { value: null, node: null };
      }
      if (name === 'issue') {
        const num = typeof args.number === 'number' ? args.number : Number(args.number);
        const issue = repo.issues.get(num);
        return issue ? { node: { type: 'issue', repo, issue } } : { value: null, node: null };
      }
      if (name === 'issues') return { connection: issuesConnection(repo, args) };
      if (name === 'pullRequest') {
        const num = typeof args.number === 'number' ? args.number : Number(args.number);
        const pull = repo.pulls.get(num);
        return pull ? { node: { type: 'pullRequest', repo, pull } } : { value: null, node: null };
      }
      if (name === 'pullRequests') return { connection: pullsConnection(repo, args) };
      break;
    }
    case 'issue': {
      const issue = node.issue;
      if (name === 'id') return { value: globalId('Issue', issue.id), node: null };
      if (name === 'number') return { value: issue.number, node: null };
      if (name === 'title') return { value: issue.title, node: null };
      if (name === 'state') return { value: issue.state === 'open' ? 'OPEN' : 'CLOSED', node: null };
      if (name === 'body') return { value: issue.body, node: null };
      if (name === 'author') return { node: { type: 'user', login: issue.author } };
      if (name === 'createdAt') return { value: issue.createdAt, node: null };
      if (name === 'updatedAt') return { value: issue.updatedAt, node: null };
      if (name === 'closedAt') return { value: issue.closedAt, node: null };
      if (name === 'url') return { value: `https://github.com/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`, node: null };
      if (name === 'repository') return { node: { type: 'repository', repo: node.repo } };
      break;
    }
    case 'pullRequest': {
      const pull = node.pull;
      if (name === 'id') return { value: globalId('PullRequest', pull.id), node: null };
      if (name === 'number') return { value: pull.number, node: null };
      if (name === 'title') return { value: pull.title, node: null };
      if (name === 'body') return { value: pull.body, node: null };
      if (name === 'state') return { value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', node: null };
      if (name === 'merged') return { value: pull.merged, node: null };
      if (name === 'mergedAt') return { value: pull.mergedAt, node: null };
      if (name === 'headRefName') return { value: pull.head.ref, node: null };
      if (name === 'baseRefName') return { value: pull.base.ref, node: null };
      if (name === 'headRefOid') return { value: pull.head.sha, node: null };
      if (name === 'baseRefOid') return { value: pull.base.sha, node: null };
      if (name === 'mergeable') return { value: computeMergeable(node.repo, pull), node: null };
      if (name === 'mergeStateStatus') return { value: computeMergeable(node.repo, pull) === 'MERGEABLE' ? 'CLEAN' : 'DIRTY', node: null };
      if (name === 'author') return { node: { type: 'user', login: pull.author } };
      if (name === 'files') return { connection: filesConnection(node.repo, pull, args) };
      if (name === 'url') return { value: `https://github.com/${node.repo.owner}/${node.repo.name}/pull/${pull.number}`, node: null };
      break;
    }
    case 'payload': {
      if (name === 'issue') return node.issue ? { node: { type: 'issue', repo: node.issue.repo, issue: node.issue.issue } } : { value: null, node: null };
      if (name === 'pullRequest') return node.pull ? { node: { type: 'pullRequest', repo: node.pull.repo, pull: node.pull.pull } } : { value: null, node: null };
      if (name === 'commentEdge') return node.comment ? { node: { type: 'commentEdge', comment: node.comment } } : { value: null, node: null };
      if (name === 'clientMutationId') return { value: null, node: null };
      break;
    }
    case 'commentEdge': {
      if (name === 'node') return { node: { type: 'comment', comment: node.comment } };
      if (name === 'cursor') return { value: 'cursor:0', node: null };
      break;
    }
    case 'comment': {
      if (name === 'id') return { value: globalId('Comment', node.comment.id), node: null };
      if (name === 'body') return { value: node.comment.body, node: null };
      if (name === 'author') return { node: { type: 'user', login: ctx.store.login } };
      if (name === 'createdAt') return { value: new Date(Date.parse('2026-11-01T00:00:00Z')).toISOString(), node: null };
      break;
    }
    case 'ref': {
      if (name === 'name') return { value: node.name, node: null };
      if (name === 'id') return { value: globalId('Ref', 0), node: null };
      break;
    }
    case 'changedFile': {
      if (name === 'path') return { value: node.path, node: null };
      break;
    }
    case 'type': {
      if (name === 'fields') return { value: (TYPE_FIELDS[node.name] ?? []).map((n) => ({ name: n })), node: null };
      if (name === 'enumValues') return { value: (TYPE_ENUMS[node.name] ?? []).map((n) => ({ name: n })), node: null };
      if (name === 'name') return { value: node.name, node: null };
      break;
    }
  }
  throw new GraphqlFieldError(`Field '${name}' doesn't exist on type '${typeNameOf(node)}'`);
}

function resolveNode(decoded: { kind: string; dbId: number }, ctx: ExecCtx): Node | null {
  for (const repo of ctx.store.repos.values()) {
    if (decoded.kind === 'Repository' && repo.id === decoded.dbId) return { type: 'repository', repo };
    const issue = repo.issues.get(decoded.dbId);
    if (decoded.kind === 'Issue' && issue) return { type: 'issue', repo, issue };
    const pull = repo.pulls.get(decoded.dbId);
    if (decoded.kind === 'PullRequest' && pull) return { type: 'pullRequest', repo, pull };
  }
  return null;
}

/** Apply a selection set to a node, returning the data object (throws on unknown fields). */
function applySelections(selection: FieldSel[], variables: Record<string, unknown>, ctx: ExecCtx, node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.name.startsWith('\u0000fragment:')) {
      const condition = sel.name.slice('\u0000fragment:'.length);
      if (condition === typeNameOf(node) || condition === 'Node') {
        Object.assign(out, applySelections(sel.selection!, variables, ctx, node));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const r = resolveRootField(sel, variables, ctx, node);
    if (r.connection !== undefined) {
      const conn = r.connection;
      const nodesField = sel.selection?.find((f) => f.name === 'nodes');
      const pageInfoField = sel.selection?.find((f) => f.name === 'pageInfo');
      const nodes = conn.items.map((item) =>
        item === null || item === undefined
          ? null
          : nodesField?.selection
            ? applySelections(nodesField.selection, variables, ctx, item)
            : {},
      );
      const pageInfoData = { hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
      const pageInfo = pageInfoField?.selection
        ? Object.fromEntries(pageInfoField.selection.map((f) => [f.alias ?? f.name, (pageInfoData as Record<string, unknown>)[f.name] ?? null]))
        : pageInfoData;
      out[key] = { nodes, pageInfo };
      continue;
    }
    if (r.node === null) {
      out[key] = r.value ?? null;
      continue;
    }
    if (sel.selection === null) {
      out[key] = r.value !== undefined ? r.value : applySelections([], variables, ctx, r.node);
      continue;
    }
    out[key] = applySelections(sel.selection, variables, ctx, r.node);
  }
  return out;
}

/** Execute one operation. */
function executeOperation(op: Operation, variables: Record<string, unknown>, ctx: ExecCtx): Record<string, unknown> {
  return applySelections(op.selection, variables, ctx, { type: op.type === 'mutation' ? 'mutationRoot' : 'queryRoot' });
}

function resolveRootField(sel: FieldSel, variables: Record<string, unknown>, ctx: ExecCtx, node: Node): { value?: unknown; node: Node | null; connection?: Connection } {
  const args = argMap(sel, variables);
  const name = sel.name;
  if (node.type === 'queryRoot') {
    if (name === 'viewer') return { node: { type: 'viewer' } };
    if (name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (owner.toLowerCase() !== ctx.store.login.toLowerCase()) return { value: null, node: null };
      const repo = ctx.store.repos.get(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
      return repo ? { node: { type: 'repository', repo } } : { value: null, node: null };
    }
    if (name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return { value: null, node: null };
      return { node: resolveNode(decoded, ctx) };
    }
    if (name === '__type') {
      const tname = typeof args.name === 'string' ? args.name : '';
      return { node: { type: 'type', name: tname } };
    }
    if (name === 'nodes') return { value: [], node: null };
  }
  if (node.type === 'mutationRoot') {
    return resolveMutation(sel, args, ctx);
  }
  return resolveField(node, sel, variables, ctx);
}

function resolveMutation(sel: FieldSel, args: Record<string, unknown>, ctx: ExecCtx): { node: Node | null } {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repoById = (id: unknown): Repo => {
    const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
    if (decoded && decoded.kind === 'Repository') {
      for (const repo of ctx.store.repos.values()) if (repo.id === decoded.dbId) return repo;
    }
    throw new GraphqlFieldError('Could not resolve to a node with the global id of `repositoryId`');
  };
  const issueById = (id: unknown, field: string): { repo: Repo; issue: Issue } => {
    const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
    if (decoded && decoded.kind === 'Issue') {
      for (const repo of ctx.store.repos.values()) {
        const issue = repo.issues.get(decoded.dbId);
        if (issue) return { repo, issue };
      }
    }
    throw new GraphqlFieldError(`Could not resolve to a node with the global id of \`${field}\``);
  };
  const pullById = (id: unknown, field: string): { repo: Repo; pull: Pull } => {
    const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
    if (decoded && decoded.kind === 'PullRequest') {
      for (const repo of ctx.store.repos.values()) {
        const pull = repo.pulls.get(decoded.dbId);
        if (pull) return { repo, pull };
      }
    }
    throw new GraphqlFieldError(`Could not resolve to a node with the global id of \`${field}\``);
  };
  switch (sel.name) {
    case 'createIssue': {
      const repo = repoById(input.repositoryId);
      const issue = createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : null });
      return { node: { type: 'payload', issue: { repo, issue } } };
    }
    case 'closeIssue': {
      const found = issueById(input.issueId, 'issueId');
      closeIssue(found.repo, found.issue);
      return { node: { type: 'payload', issue: found } };
    }
    case 'createPullRequest': {
      const repo = repoById(input.repositoryId);
      const pull = createPull(repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
      });
      return { node: { type: 'payload', pull: { repo, pull } } };
    }
    case 'mergePullRequest': {
      const found = pullById(input.pullRequestId, 'pullRequestId');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const outcome = mergePull(found.repo, found.pull, method);
      if (!outcome.ok) throw new GraphqlFieldError('Pull Request is not mergeable');
      return { node: { type: 'payload', pull: found } };
    }
    case 'addComment': {
      const found = issueById(input.subjectId, 'subjectId');
      const comment = addComment(found.repo, found.issue, String(input.body ?? ''));
      return { node: { type: 'payload', comment: { id: comment.id, body: comment.body } } };
    }
    default:
      throw new GraphqlFieldError(`The mutation \`${sel.name}\` does not exist`);
  }
}

// ---------------------------------------------------------------- endpoint

/** Run one request body (object or batch array) into envelope(s). */
export function handleGraphql(ctx: Ctx): { status: number; body: unknown } {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '' && (ctx.token === null || !tokenOk(ctx))) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  const execCtx: ExecCtx = { store: ctx.store };
  const body = ctx.body;
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne((entry as { query?: unknown })?.query, (entry as { variables?: unknown })?.variables, execCtx)) };
  }
  const entry = (body ?? {}) as { query?: unknown; variables?: unknown };
  return { status: 200, body: runOne(entry.query, entry.variables, execCtx) };
}

function runOne(query: unknown, variables: unknown, ctx: ExecCtx): GraphqlEnvelope {
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  try {
    const ops = new Parser(tokenize(query)).parseDocument();
    const op = ops[0];
    if (!op) return { data: null, errors: [{ message: 'No operations found in the query.' }] };
    const vars = (variables && typeof variables === 'object' ? variables : {}) as Record<string, unknown>;
    return { data: executeOperation(op, vars, ctx) };
  } catch (err) {
    if (err instanceof GraphqlFieldError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    const message = err instanceof Error ? err.message : 'Bad request';
    return { data: null, errors: [{ message: `Parse error: ${message}` }] };
  }
}
