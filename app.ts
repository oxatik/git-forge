// The forge's HTTP server: one router for git smart HTTP, REST v3, GraphQL v4 and MCP.
// Everything is in-process and in-memory; the store lives in store.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { newStore, type Store } from './store.ts';
import { dispatchRest, RestError, type Ctx } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, handleUploadPack, handleReceivePack, GitHttpError } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const store: Store = newStore();

/** A deterministic, strictly increasing request id (no wall clock, no randomness). */
let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36).padStart(6, '0')}`;
}

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const out: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': headers['x-github-request-id'] ?? nextRequestId(),
  };
  if (body !== undefined) out['content-length'] = String(Buffer.byteLength(text));
  for (const k in headers) if (k !== 'x-github-request-id') out[k] = headers[k];
  res.writeHead(status, out);
  res.end(text);
}

/** The bearer token of a request, or null when none was presented. */
function tokenOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || raw === '') return null;
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : raw;
}

/** Read a request body with a size cap. */
function readBody(req: IncomingMessage, cap = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new RestError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Shared read-only empty query (never mutated; see routeInner). */
const EMPTY_QUERY = new URLSearchParams();

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await routeInner(req, res);
  } catch (err) {
    process.stderr.write(`[forge] ${req.method} ${req.url} -> ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.end();
  }
}

async function routeInner(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const url = req.url ?? '/';
  const qIndex = url.indexOf('?');
  // Query strings are only ever read, never written, so one shared empty instance serves every
  // request without one — the read/write benches and the git exchanges have no query at all.
  const query = qIndex < 0 ? EMPTY_QUERY : new URLSearchParams(url.slice(qIndex + 1));
  const rawPath = qIndex < 0 ? url : url.slice(0, qIndex);
  const method = req.method ?? 'GET';
  const path = decodePath(rawPath);
  const token = tokenOf(req);
  const reqHost = req.headers.host ?? 'localhost';

  const jsonHeaders: Record<string, string> = { 'x-github-request-id': requestId };

  // The env's boot probe: 200 {"ok":true}, twice, no auth.
  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true }, jsonHeaders);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/…
  const gitMatch = GIT_RE.exec(path);
  if (gitMatch) {
    const [, owner, repoName, action] = gitMatch;
    const repo = store.repos.get(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
    try {
      if (action === 'info/refs') {
        if (!repo) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId });
          res.end('Not Found\n');
          return;
        }
        if (method !== 'GET') throw new GitHttpError('GET required', 405);
        const service = query.get('service') ?? '';
        const protoV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        const out = infoRefs(repo, service, protoV2);
        res.writeHead(200, { 'content-type': out.contentType, 'x-github-request-id': requestId, 'cache-control': 'no-cache' });
        res.end(out.body);
        return;
      }
      if (!repo) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId });
        res.end('Not Found\n');
        return;
      }
      const body = await readBody(req);
      const out =
        action === 'git-upload-pack'
          ? handleUploadPack(repo, body, (req.headers['git-protocol'] ?? '').includes('version=2'))
          : handleReceivePack(repo, body);
      res.writeHead(200, { 'content-type': out.contentType, 'x-github-request-id': requestId, 'cache-control': 'no-cache' });
      res.end(out.body);
    } catch (err) {
      if (err instanceof GitHttpError) {
        res.writeHead(err.status, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId });
        res.end(`${err.message}\n`);
      } else {
        process.stderr.write(`[forge] git ${method} ${path} -> ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId });
        res.end('Internal Server Error\n');
      }
    }
    return;
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const raw = await readBody(req);
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, jsonHeaders);
        return;
      }
    }
    const ctx: Ctx = { method, path, query, body, rawBody: raw, token, store, reqHost };
    try {
      const out = dispatchRest(ctx);
      sendJson(res, out.status, out.status === 204 ? undefined : out.body, { ...jsonHeaders, ...(out.headers ?? {}) });
    } catch (err) {
      if (err instanceof RestError) sendJson(res, err.status, { message: err.message, documentation_url: 'https://docs.github.com/rest' }, jsonHeaders);
      else {
        process.stderr.write(`[forge] rest ${method} ${path} -> ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' }, jsonHeaders);
      }
    }
    return;
  }

  // GraphQL v4
  if (path === '/api/graphql' || path === '/api/graphql/') {
    const raw = await readBody(req);
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = undefined; // the GraphQL layer answers an errors envelope
      }
    }
    const ctx: Ctx = { method, path, query, body, rawBody: raw, token, store, reqHost };
    try {
      const out = handleGraphql(ctx);
      sendJson(res, out.status, out.body, jsonHeaders);
    } catch {
      sendJson(res, 500, { message: 'Internal Server Error' }, jsonHeaders);
    }
    return;
  }

  // MCP
  if (path === '/mcp' || path === '/mcp/') {
    if (method === 'DELETE') {
      // No session was ever issued; acknowledge and move on.
      res.writeHead(200, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
    const raw = await readBody(req);
    const ctx: Ctx = { method, path, query, body: undefined, rawBody: raw, token, store, reqHost };
    try {
      const out = handleMcp(ctx);
      if (out.body === undefined) {
        res.writeHead(out.status, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendJson(res, out.status, out.body, jsonHeaders);
    } catch {
      sendJson(res, 500, { message: 'Internal Server Error' }, jsonHeaders);
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, jsonHeaders);
}

/** Percent-decode a request path, segment by segment (keeping '/'). Paths without escapes skip the work. */
function decodePath(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return raw
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/');
  } catch {
    return raw;
  }
}
