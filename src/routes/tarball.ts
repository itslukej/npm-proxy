import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { sendUpstreamError } from '../httpErrors.js';
import { encodedNamePath, versionFromTarballFilename } from '../paths.js';
import { blockedMessage, decideVersion } from '../policy.js';

/**
 * GET/HEAD /{name}/-/{file}.tgz — the enforcement backstop. Old lockfiles
 * carry resolved tarball URLs, so metadata filtering alone is bypassable;
 * every tarball download re-checks the age policy before any upstream byte
 * is streamed. Fails closed when the publish timestamp cannot be determined.
 */
export async function handleTarball(
  ctx: AppContext,
  name: string,
  filename: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const version = versionFromTarballFilename(name, filename);
  if (version === null) {
    return reply.code(404).send({ error: 'Not Found' });
  }

  let result;
  try {
    result = await ctx.metadata.getPackument(name);
  } catch (err) {
    req.log.warn({ package: name, version, err }, 'upstream failure while checking tarball policy');
    return sendUpstreamError(reply, err);
  }
  if (result.kind === 'not-found') {
    return reply.code(404).send({ error: 'Not Found' });
  }

  const decision = decideVersion(name, version, result.doc.time, ctx.config, ctx.now());
  const logFields = {
    package: name,
    version,
    publishedAt: 'publishedAt' in decision ? decision.publishedAt : undefined,
    ageHours: 'ageMs' in decision ? Math.round((decision.ageMs / 3_600_000) * 10) / 10 : undefined,
    minimumAgeHours: ctx.config.minAgeHours,
  };

  if (!decision.allowed) {
    // A version absent from BOTH `versions` and `time` simply doesn't exist;
    // present-but-untimestamped versions stay a 403 (fail closed).
    if (decision.reason === 'unknown-publish-time' && !result.doc.versions?.[version]) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    ctx.metrics.inc('tarballs_blocked_total');
    req.log.info({ ...logFields, reason: decision.reason }, 'tarball blocked');
    return reply.code(403).send({ error: blockedMessage(name, version, decision, ctx.config) });
  }

  // A version can be excluded from the policy yet absent upstream; anything
  // else missing from `versions` is simply not found.
  if (decision.reason === 'old-enough' && !result.doc.versions?.[version]) {
    return reply.code(404).send({ error: 'Not Found' });
  }

  ctx.metrics.inc('tarballs_allowed_total');
  req.log.info({ ...logFields, reason: decision.reason }, 'tarball allowed');

  const upstreamPath = `/${encodedNamePath(name)}/-/${filename}`;

  if (req.method === 'HEAD') {
    return proxyHead(ctx, upstreamPath, reply);
  }

  if (ctx.tarballCache) {
    const cached = await ctx.tarballCache.open(name, filename);
    if (cached) {
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', cached.size);
      return reply.code(200).send(cached.stream);
    }
  }

  let upstream;
  try {
    upstream = await ctx.upstream.open('GET', upstreamPath);
  } catch (err) {
    ctx.metrics.inc('upstream_errors_total');
    req.log.warn({ package: name, version, err }, 'upstream failure streaming tarball');
    return sendUpstreamError(reply, err);
  }

  if (upstream.statusCode === 404) {
    upstream.body.resume();
    return reply.code(404).send({ error: 'Not Found' });
  }
  if (upstream.statusCode !== 200) {
    ctx.metrics.inc('upstream_errors_total');
    upstream.body.resume();
    return reply.code(502).send({ error: `upstream registry returned HTTP ${upstream.statusCode}` });
  }

  reply.header('content-type', String(upstream.headers['content-type'] ?? 'application/octet-stream'));
  for (const h of ['content-length', 'etag', 'last-modified'] as const) {
    const value = upstream.headers[h];
    if (typeof value === 'string') reply.header(h, value);
  }

  // Stop pulling from upstream if the client goes away mid-stream.
  req.raw.once('close', () => {
    if (!upstream.body.readableEnded) upstream.body.destroy();
  });

  if (ctx.tarballCache) {
    ctx.tarballCache.writeThrough(name, filename, upstream.body);
  }
  return reply.code(200).send(upstream.body);
}

async function proxyHead(ctx: AppContext, upstreamPath: string, reply: FastifyReply): Promise<FastifyReply> {
  let upstream;
  try {
    upstream = await ctx.upstream.open('HEAD', upstreamPath);
  } catch (err) {
    ctx.metrics.inc('upstream_errors_total');
    return sendUpstreamError(reply, err);
  }
  upstream.body.resume();
  for (const h of ['content-type', 'content-length', 'etag', 'last-modified'] as const) {
    const value = upstream.headers[h];
    if (typeof value === 'string') reply.header(h, value);
  }
  return reply.code(upstream.statusCode === 200 ? 200 : 404).send();
}
