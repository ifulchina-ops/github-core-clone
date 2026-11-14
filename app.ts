// app.ts: the one-process forge. HTTP entry point — authentication, JSON parsing,
// routing to REST v3 / GraphQL / MCP / the git smart-HTTP endpoints — over one Store.
// Every reply is JSON (except the git pack streams, which are binary by design);
// nothing here ever returns an HTML error page.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

export interface ForgeApp {
  readonly server: Server;
  readonly store: Store;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token this process trusts (the trial token, from the environment). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function createApp(): ForgeApp {
  const store = new Store();
  const server = createServer((req, res) => {
    void handleRequest(req, res, store).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': `req-${++requestCounter}` });
        res.end(JSON.stringify({ message: `Internal error: ${detail}` }));
      } else {
        res.end();
      }
    });
  });
  return {
    server,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const requestId = `req-${++requestCounter}`;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = url.pathname;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  };

  // The health probe needs no credentials and answers before anything else.
  if (pathname === '/healthz') {
    json(200, { ok: true });
    return;
  }

  // Authenticate every forge surface: REST, GraphQL, MCP and the git endpoints.
  const needsAuth =
    pathname === '/api/graphql' ||
    pathname === '/mcp' ||
    pathname.startsWith('/api/v3') ||
    /\.git\//.test(pathname);
  if (needsAuth) {
    const header = req.headers.authorization ?? '';
    const token = expectedToken();
    if (token === '' || header !== `Bearer ${token}`) {
      json(401, { message: 'Unauthorized' });
      return;
    }
  }

  const body = await readBody(req);

  // The git smart-HTTP endpoints take a binary pkt-line body, never JSON.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] ?? '');
    const repoName = decodeURIComponent(gitMatch[2] ?? '');
    const tail = gitMatch[3] ?? '';
    if (tail === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      handleInfoRefs(req, res, store, owner, repoName, service);
      return;
    }
    if (tail === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, store, owner, repoName, body);
      return;
    }
    if (tail === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, store, owner, repoName, body);
      return;
    }
    json(404, { message: 'Not Found' });
    return;
  }

  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      json(200, {});
      return;
    }
    handleMcp({ store, bodyText: body.toString('utf8'), json });
    return;
  }

  if (pathname === '/api/graphql') {
    const parsed = parseJsonBody(body);
    if (parsed.error) {
      json(400, { message: parsed.error });
      return;
    }
    handleGraphQL({ store, body: parsed.value, json });
    return;
  }

  if (pathname.startsWith('/api/v3')) {
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    let parsedBody: unknown;
    if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      const parsed = parseJsonBody(body);
      if (parsed.error) {
        json(400, { message: parsed.error });
        return;
      }
      parsedBody = parsed.value;
    }
    const ctx: RestCtx = { req, res, store, method, segments, query: url.searchParams, body: parsedBody, requestId, json };
    if (!handleRest(ctx)) json(404, { message: 'Not Found' });
    return;
  }

  json(404, { message: 'Not Found' });
}

/** Parse a JSON body; a body that is not valid JSON reports its error message. */
function parseJsonBody(body: Buffer): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
  const text = body.toString('utf8');
  if (text.trim() === '') return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'Invalid JSON' };
  }
}
