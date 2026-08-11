import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext, FilteredMetadata } from '../context.js';
import { sendUpstreamError } from '../httpErrors.js';
import { filterPackument } from '../policy.js';

/**
 * How long a serialized filtered response may be reused. Bounded at 60s so
 * versions still age past the threshold promptly (matching the max-age we
 * hand to clients); never longer than the raw-packument TTL.
 */
const FILTERED_TTL_CAP_MS = 60_000;

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

  const cached = await ctx.filteredCache.get(name);
  if (cached) {
    return serveFiltered(req, reply, cached);
  }

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
  const entry: FilteredMetadata = { body, etag };
  await ctx.filteredCache.set(
    name,
    entry,
    Math.min(FILTERED_TTL_CAP_MS, ctx.config.metadataCacheTtlMs),
    body.length * 2,
  );
  return serveFiltered(req, reply, entry);
}

function serveFiltered(req: FastifyRequest, reply: FastifyReply, entry: FilteredMetadata): FastifyReply {
  reply.header('etag', entry.etag);
  reply.header('cache-control', 'public, max-age=60');
  reply.header('content-type', 'application/json');

  if (etagMatches(req.headers['if-none-match'], entry.etag)) {
    return reply.code(304).send();
  }
  reply.header('content-length', Buffer.byteLength(entry.body));
  if (req.method === 'HEAD') {
    return reply.code(200).send();
  }
  return reply.code(200).send(entry.body);
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').some((token) => {
    const t = token.trim();
    return t === '*' || t === etag || t === `W/${etag}` || `W/${t}` === etag;
  });
}
