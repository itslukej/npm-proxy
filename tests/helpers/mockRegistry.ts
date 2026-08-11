import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

export interface RouteDef {
  status?: number;
  body?: string | Buffer;
  contentType?: string;
  /** Delay before writing anything (exercises header timeouts). */
  delayMs?: number;
  gzip?: boolean;
  redirectTo?: string;
  headers?: Record<string, string>;
}

export interface MockRegistry {
  url: string;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  /** Register a route by "/path" (any method) or "METHOD /path". */
  route(key: string, def: RouteDef): void;
  requestCount(pathPrefix: string): number;
  close(): Promise<void>;
}

export async function startMockRegistry(): Promise<MockRegistry> {
  const routes = new Map<string, RouteDef>();
  const requests: MockRegistry['requests'] = [];

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const path = (req.url ?? '').split('?')[0]!;
    const def = routes.get(`${req.method} ${path}`) ?? routes.get(path);

    const respond = () => {
      if (!def) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      if (def.redirectTo) {
        res.statusCode = def.status ?? 302;
        res.setHeader('location', def.redirectTo);
        res.end();
        return;
      }
      res.statusCode = def.status ?? 200;
      let body = typeof def.body === 'string' ? Buffer.from(def.body) : (def.body ?? Buffer.alloc(0));
      if (def.gzip) {
        body = gzipSync(body);
        res.setHeader('content-encoding', 'gzip');
      }
      res.setHeader('content-type', def.contentType ?? 'application/json');
      for (const [k, v] of Object.entries(def.headers ?? {})) res.setHeader(k, v);
      res.setHeader('content-length', body.length);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    };

    // Consume any request body first so POSTs complete.
    req.resume();
    req.on('end', () => {
      if (def?.delayMs) setTimeout(respond, def.delayMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    route: (key, def) => routes.set(key, def),
    requestCount: (pathPrefix) => requests.filter((r) => r.url.split('?')[0]!.startsWith(pathPrefix)).length,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
