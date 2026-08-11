import type { FastifyReply } from 'fastify';

import { UpstreamError } from './registry.js';

/**
 * Map an upstream failure to an npm-compatible error response. Policy blocks
 * are 403 elsewhere; upstream trouble must surface as 5xx so npm clients
 * retry instead of caching a bogus policy outcome.
 */
export function sendUpstreamError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UpstreamError) {
    const status = err.kind === 'timeout' ? 504 : 502;
    return reply.code(status).send({ error: `upstream registry unavailable: ${err.kind}` });
  }
  throw err;
}
