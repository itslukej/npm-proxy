import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';

import { Agent, request } from 'undici';

import type { Config } from './config.js';

export type UpstreamErrorKind =
  | 'timeout'
  | 'network'
  | 'bad-json'
  | 'too-large'
  | 'bad-redirect'
  | 'status';

export class UpstreamError extends Error {
  constructor(
    public readonly kind: UpstreamErrorKind,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function isTimeout(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
}

/**
 * HTTP client for the configured upstream registry. Requests can only ever
 * target the configured origin: URLs are built from config + validated path
 * segments, and redirects are followed only within that origin.
 */
export class UpstreamClient {
  private readonly agent: Agent;
  private readonly base: URL;

  constructor(private readonly config: Pick<Config, 'upstreamRegistry' | 'upstreamTimeoutMs' | 'maxMetadataBytes'>) {
    this.base = new URL(config.upstreamRegistry + '/');
    this.agent = new Agent({
      connect: { timeout: config.upstreamTimeoutMs },
      headersTimeout: config.upstreamTimeoutMs,
      // Body timeout is per-chunk (idle), so large tarballs on slow links still work.
      bodyTimeout: Math.max(config.upstreamTimeoutMs, 30_000),
      connections: 64,
    });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  /**
   * Fetch and parse a JSON document from the upstream registry. Always asks
   * for the full format (never forwards the client's corgi Accept header —
   * the abbreviated packument has no `time` map). Enforces the configured
   * size cap on DECOMPRESSED bytes.
   */
  async fetchJson(path: string): Promise<{ statusCode: number; json?: unknown }> {
    const res = await this.open('GET', path, {
      accept: 'application/json',
      'accept-encoding': 'gzip',
    });

    if (res.statusCode !== 200) {
      await this.drain(res.body);
      return { statusCode: res.statusCode };
    }

    const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
    let stream: Readable = res.body;
    if (encoding.includes('gzip')) {
      const gunzip = createGunzip();
      res.body.on('error', (err: Error) => gunzip.destroy(err));
      stream = res.body.pipe(gunzip);
    } else if (encoding && encoding !== 'identity') {
      res.body.destroy();
      throw new UpstreamError('network', `unsupported upstream content-encoding: ${encoding}`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > this.config.maxMetadataBytes) {
          res.body.destroy();
          throw new UpstreamError('too-large', `upstream metadata exceeded ${this.config.maxMetadataBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (isTimeout(err)) throw new UpstreamError('timeout', 'upstream body timed out');
      throw new UpstreamError('network', `upstream body failed: ${(err as Error).message}`);
    }

    try {
      return { statusCode: 200, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      throw new UpstreamError('bad-json', 'upstream returned malformed JSON');
    }
  }

  /**
   * Open a streaming GET (or HEAD) against the upstream, following at most
   * MAX_REDIRECTS same-origin redirects. Caller owns the returned body.
   */
  async open(method: 'GET' | 'HEAD', path: string, headers: Record<string, string> = {}): Promise<UpstreamResponse> {
    let url = new URL(path.replace(/^\//, ''), this.base);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.dispatch(method, url, headers);
      if (REDIRECT_CODES.has(res.statusCode)) {
        const location = res.headers.location;
        await this.drain(res.body);
        if (typeof location !== 'string' || location.length === 0) {
          throw new UpstreamError('bad-redirect', 'upstream redirect without location');
        }
        const next = new URL(location, url);
        if (next.origin !== this.base.origin) {
          throw new UpstreamError('bad-redirect', `upstream redirected outside the configured registry: ${next.origin}`);
        }
        url = next;
        continue;
      }
      return res;
    }
    throw new UpstreamError('bad-redirect', 'too many upstream redirects');
  }

  /** Proxy a request body upstream (used only for allowlisted audit endpoints). */
  async proxy(
    method: 'GET' | 'HEAD' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: Readable,
  ): Promise<UpstreamResponse> {
    const url = new URL(path.replace(/^\//, ''), this.base);
    return this.dispatch(method, url, headers, body);
  }

  private async dispatch(
    method: 'GET' | 'HEAD' | 'POST',
    url: URL,
    headers: Record<string, string>,
    body?: Readable,
  ): Promise<UpstreamResponse> {
    try {
      // undici does not follow redirects by default; `open()` handles them
      // explicitly with a same-origin restriction.
      const res = await request(url, {
        method,
        headers,
        body,
        dispatcher: this.agent,
      });
      return { statusCode: res.statusCode, headers: res.headers, body: res.body as unknown as Readable };
    } catch (err) {
      if (isTimeout(err)) throw new UpstreamError('timeout', 'upstream request timed out');
      throw new UpstreamError('network', `upstream request failed: ${(err as Error).message}`);
    }
  }

  private async drain(body: Readable): Promise<void> {
    try {
      body.resume();
      await new Promise<void>((resolve) => {
        body.once('end', resolve);
        body.once('error', () => resolve());
        body.once('close', resolve);
      });
    } catch {
      /* draining is best-effort */
    }
  }
}
