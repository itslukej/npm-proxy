import type { Readable } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { sendUpstreamError } from '../httpErrors.js';

/**
 * Registry meta endpoints are proxied default-CLOSED: endpoints like
 * /-/v1/search or /-/package/{pkg}/dist-tags would leak unfiltered version
 * data, so only a small allowlist passes through.
 *
 * The audit POSTs are npm 6's read-only-in-spirit vulnerability lookups,
 * sent automatically during `npm install`; rejecting them makes every
 * install noisy.
 */
const GET_ALLOWLIST = new Set(['/-/ping']);
const POST_ALLOWLIST = new Set([
  '/-/npm/v1/security/audits',
  '/-/npm/v1/security/audits/quick',
  '/-/v1/security/advisories/bulk',
]);

export function isAllowedMetaPath(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return GET_ALLOWLIST.has(path);
  if (method === 'POST') return POST_ALLOWLIST.has(path);
  return false;
}

/** Proxy an allowlisted meta endpoint. Client Authorization is never forwarded upstream. */
export async function handleMetaPassthrough(
  ctx: AppContext,
  path: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const method = req.method as 'GET' | 'HEAD' | 'POST';
  const headers: Record<string, string> = { accept: 'application/json' };
  for (const h of ['content-type', 'content-encoding', 'content-length'] as const) {
    const value = req.headers[h];
    if (typeof value === 'string') headers[h] = value;
  }

  let upstream;
  try {
    upstream = await ctx.upstream.proxy(
      method,
      path,
      headers,
      method === 'POST' ? (req.body as Readable) : undefined,
    );
  } catch (err) {
    ctx.metrics.inc('upstream_errors_total');
    req.log.warn({ path, err }, 'upstream failure on meta passthrough');
    return sendUpstreamError(reply, err);
  }

  for (const h of ['content-type', 'content-encoding', 'content-length'] as const) {
    const value = upstream.headers[h];
    if (typeof value === 'string') reply.header(h, value);
  }
  if (method === 'HEAD') {
    upstream.body.resume();
    return reply.code(upstream.statusCode).send();
  }
  return reply.code(upstream.statusCode).send(upstream.body);
}
