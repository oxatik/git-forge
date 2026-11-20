// MCP over streamable HTTP: POST /mcp, one JSON-RPC message per request. The suite drives the
// legacy era: it probes server/discover first (refused with -32601, which routes the client to
// the initialize handshake), lists six tools and calls them. Everything reads and writes the
// same store as /api/v3 so parity checks hold.

import { createRepo, findRepo, type Repo, type Store } from './store.ts';
import { createIssue, createPull, issueJson, mergePull, repoJson, userJson, tokenOk, type Ctx } from './rest.ts';

type JsonRpcId = string | number | null;
type JsonRpcError = { code: number; message: string };
type JsonRpcResult = Record<string, unknown>;

type ToolSpec = {
  name: string;
  description: string;
  schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
};

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of one repository by owner and name.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'The head branch' },
        base: { type: 'string', description: 'The base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash by default).',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash or rebase', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcRequest = { id: JsonRpcId; method: string; params: Record<string, unknown> };

function rpcResponse(id: JsonRpcId, result?: JsonRpcResult, error?: JsonRpcError): Record<string, unknown> {
  const out: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error !== undefined) out.error = error;
  else out.result = result ?? {};
  return out;
}

function findRepoOrThrow(store: Store, owner: string, repo: string): Repo {
  const found = findRepo(store, owner, repo);
  if (!found || owner.toLowerCase() !== store.login.toLowerCase()) {
    throw new Error(`Repository ${owner}/${repo} not found`);
  }
  return found;
}

/** Run one tools/call against the store; returns the payload object (or throws with a message). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) throw new ToolNotFound(name);
  const missing = spec.schema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) throw new ToolArgsError(`Missing required arguments: ${missing.join(', ')}`);
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repoName)) throw new Error(`Invalid repository name "${repoName}"`);
      const key = `${store.login.toLowerCase()}/${repoName.toLowerCase()}`;
      let repo = store.repos.get(key);
      if (!repo) {
        repo = createRepo(store, store.login, repoName, {
          description: typeof args.description === 'string' ? args.description : null,
          private: args.private === true,
        });
      }
      return { ...repoJson(repo), full_name: `${repo.owner}/${repo.name}`, id: repo.id };
    }
    case 'get_repo': {
      const repo = findRepoOrThrow(store, String(args.owner), String(args.repo));
      return { ...repoJson(repo), full_name: `${repo.owner}/${repo.name}`, id: repo.id };
    }
    case 'create_issue': {
      const repo = findRepoOrThrow(store, String(args.owner), String(args.repo));
      const issue = createIssue(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : null });
      return { ...issueJson(repo, issue), full_name: `${repo.owner}/${repo.name}`, number: issue.number };
    }
    case 'list_issues': {
      const repo = findRepoOrThrow(store, String(args.owner), String(args.repo));
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()].sort((a, b) => a.seq - b.seq).filter((i) => state === 'all' || i.state === state);
      return list.map((i) => issueJson(repo, i)) as unknown as Record<string, unknown>;
    }
    case 'create_pull_request': {
      const repo = findRepoOrThrow(store, String(args.owner), String(args.repo));
      const pull = createPull(repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
      });
      return { ...pullShape(repo, pull), full_name: `${repo.owner}/${repo.name}` };
    }
    case 'merge_pull_request': {
      const repo = findRepoOrThrow(store, String(args.owner), String(args.repo));
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(num);
      if (!pull) throw new Error(`Pull request ${num} not found`);
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const outcome = mergePull(repo, pull, method);
      if (!outcome.ok) throw new Error('Pull Request is not mergeable');
      return { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged', number: pull.number };
    }
    default:
      throw new ToolNotFound(name);
  }
}

function pullShape(repo: Repo, pull: { number: number; state: string; merged: boolean; head: { ref: string; sha: string }; base: { ref: string; sha: string } }): Record<string, unknown> {
  return {
    number: pull.number,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
}

void repoJson;

class ToolNotFound extends Error {}
class ToolArgsError extends Error {}

/** POST /mcp handler. Returns the HTTP status and body (object, or undefined for notifications). */
export function handleMcp(ctx: Ctx): { status: number; body: unknown; headers?: Record<string, string> } {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '' && (ctx.token === null || !tokenOk(ctx))) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = parsed as { id?: JsonRpcId; method?: unknown; params?: unknown };
  if (typeof req.method !== 'string' || req.method === '') {
    return { status: 400, body: rpcResponse(null, undefined, { code: -32600, message: 'Invalid Request: method is required' }) };
  }
  const hasId = req.id !== undefined && req.id !== null;
  const id = hasId ? (req.id as JsonRpcId) : null;
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (!hasId) {
    // A notification (e.g. notifications/initialized): accept and answer empty.
    return { status: 202, body: undefined };
  }
  switch (req.method) {
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'].includes(offered) ? offered : '2025-06-18';
      return {
        status: 200,
        body: rpcResponse(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        }),
      };
    }
    case 'server/discover': {
      // Refuse the safe way: a -32601 JSON-RPC error sends the client to the legacy handshake.
      return { status: 200, body: rpcResponse(id, undefined, { code: -32601, message: 'Method not found: server/discover is not supported' }) };
    }
    case 'tools/list': {
      return {
        status: 200,
        body: rpcResponse(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) }),
      };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.find((t) => t.name === toolName);
      if (toolName === '' || !known) {
        return { status: 200, body: rpcResponse(id, undefined, { code: -32602, message: `Unknown tool: ${toolName}` }) };
      }
      try {
        const payload = callTool(ctx.store, toolName, args);
        return {
          status: 200,
          body: rpcResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: false,
          }),
        };
      } catch (err) {
        if (err instanceof ToolArgsError) {
          return { status: 200, body: rpcResponse(id, undefined, { code: -32602, message: err.message }) };
        }
        const message = err instanceof Error ? err.message : 'tool failed';
        return {
          status: 200,
          body: rpcResponse(id, { content: [{ type: 'text', text: message }], isError: true }),
        };
      }
    }
    case 'ping':
      return { status: 200, body: rpcResponse(id, {}) };
    default:
      return { status: 200, body: rpcResponse(id, undefined, { code: -32601, message: `Method not found: ${req.method}` }) };
  }
}
