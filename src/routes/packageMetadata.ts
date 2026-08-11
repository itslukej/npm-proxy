import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { sendUpstreamError } from '../httpErrors.js';
import { filterPackument } from '../policy.js';

/**
 * GET/HEAD /{name} — serve the upstream packument with too-young versions
 * removed, dist-tags repaired, and tarball URLs rewritten to the proxy.
 *
 * Upstream ETag/Last-Modified are meaningless for the transformed body (and
 * our response changes as versions age past the threshold even when the
 * upstream document doesn't), so we compute our own ETag over the filtered
 * body and keep client caching short.
 */
export async function handleMetadata(
  ctx: AppContext,
  name: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  ctx.metrics.inc('metadata_requests_total');
  req.log.info({ package: name }, 'package metadata requested');

  let result;
  try {
    result = await ctx.metadata.getPackument(name);
  } catch (err) {
    req.log.warn({ package: name, err }, 'upstream failure fetching packument');
    return sendUpstreamError(reply, err);
  }
  if (result.kind === 'not-found') {
    return reply.code(404).send({ error: 'Not Found' });
  }

  const filtered = filterPackument(result.doc, name, ctx.config, ctx.now());
  if (filtered.kind === 'empty') {
    ctx.metrics.inc('versions_blocked_total', filtered.blockedCount);
    req.log.info(
      { package: name, blocked: filtered.blockedCount, minimumAgeHours: ctx.config.minAgeHours },
      'no versions satisfy the minimum age policy',
    );
    return reply.code(404).send({
      error: `no versions of ${name} satisfy the minimum package age of ${ctx.config.minAgeHours} hours`,
    });
  }

  if (filtered.blockedCount > 0) {
    ctx.metrics.inc('versions_blocked_total', filtered.blockedCount);
    req.log.info(
      {
        package: name,
        blocked: filtered.blockedCount,
        allowed: filtered.allowedCount,
        minimumAgeHours: ctx.config.minAgeHours,
      },
      'versions filtered from metadata',
    );
  }

  const body = JSON.stringify(filtered.doc);
  const etag = `"${createHash('sha1').update(body).digest('hex')}"`;

  reply.header('etag', etag);
  reply.header('cache-control', 'public, max-age=60');
  reply.header('content-type', 'application/json');

  if (etagMatches(req.headers['if-none-match'], etag)) {
    return reply.code(304).send();
  }
  reply.header('content-length', Buffer.byteLength(body));
  if (req.method === 'HEAD') {
    return reply.code(200).send();
  }
  return reply.code(200).send(body);
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').some((token) => {
    const t = token.trim();
    return t === '*' || t === etag || t === `W/${etag}` || `W/${t}` === etag;
  });
}
