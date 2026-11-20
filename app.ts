// The HTTP plumbing: one server, four surfaces. Routing, the bearer-token gate (the token is
// the process's MAKEFUN_SHOP_TOKEN; /healthz is the only unauthenticated route), body
// collection, and a JSON answer for everything — including a JSON 404 for unknown routes and
// a JSON 500 that keeps the server alive when a handler fails.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './core.ts';
import { handleRest, type Reply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './gitp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

function send(res: ServerResponse, reply: Reply): void {
  res.statusCode = reply.status;
  if (reply.headers !== undefined) {
    for (const [name, value] of Object.entries(reply.headers)) res.setHeader(name, value);
  }
  if (reply.raw !== undefined) {
    res.setHeader('content-type', reply.contentType ?? 'application/octet-stream');
    res.end(reply.raw);
    return;
  }
  if (reply.body === undefined) {
    res.end();
    return;
  }
  res.setHeader('content-type', reply.contentType ?? 'application/json; charset=utf-8');
  res.end(JSON.stringify(reply.body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authed = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const server = createServer((req, res) => {
    res.setHeader('x-github-request-id', nextRequestId());
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const method = req.method ?? 'GET';
        const path = url.pathname;

        if (path === '/healthz') {
          send(res, { status: 200, body: { ok: true } });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!authed(req)) {
            send(res, { status: 401, body: { message: 'Requires authentication' } });
            return;
          }
          const owner = decodeSegment(gitMatch[1]!);
          const name = decodeSegment(gitMatch[2]!);
          const endpoint = gitMatch[3]!;
          const repo = forge.getRepo(owner, name);
          if (repo === undefined) {
            send(res, { status: 404, raw: Buffer.from('repository not found\n'), contentType: 'text/plain' });
            return;
          }
          if (endpoint === 'info/refs' && method === 'GET') {
            const protocol = req.headers['git-protocol'];
            const version = typeof protocol === 'string' && protocol.includes('version=2') ? '2' : null;
            send(res, infoRefs(forge, repo, url.searchParams.get('service') ?? '', version));
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            send(res, uploadPack(forge, repo, body));
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            send(res, receivePack(forge, repo, body));
            return;
          }
          send(res, { status: 404, body: { message: 'Not Found' } });
          return;
        }

        if (path === '/api/graphql') {
          if (!authed(req)) {
            send(res, { status: 401, body: { message: 'Requires authentication' } });
            return;
          }
          if (method !== 'POST') {
            send(res, { status: 404, body: { message: 'Not Found' } });
            return;
          }
          send(res, handleGraphQL(forge, body.toString('utf8')));
          return;
        }

        if (path === '/mcp') {
          if (!authed(req)) {
            send(res, { status: 401, body: { message: 'Requires authentication' } });
            return;
          }
          if (method !== 'POST') {
            send(res, { status: 405, body: { message: 'Method Not Allowed' } });
            return;
          }
          send(res, handleMcp(forge, body.toString('utf8')));
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            send(res, { status: 401, body: { message: 'Requires authentication' } });
            return;
          }
          const rest = path.slice('/api/v3'.length).replace(/^\//, '');
          const segments = rest === '' ? [] : rest.split('/').map(decodeSegment);
          const host = req.headers.host ?? 'localhost';
          send(res, handleRest({
            forge,
            method,
            segments,
            query: url.searchParams,
            body,
            origin: `http://${host}`,
          }));
          return;
        }

        send(res, { status: 404, body: { message: 'Not Found' } });
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ message: `internal error: ${err instanceof Error ? err.message : String(err)}` }));
        } else {
          res.destroy();
        }
      }
    })();
  });
  return server;
}
