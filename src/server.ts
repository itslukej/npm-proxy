import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { MemoryCache } from './cache.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { MetadataService } from './metadata.js';
import { Metrics } from './metrics.js';
import { parseRegistryPath } from './paths.js';
import { UpstreamClient } from './registry.js';
import { handleHealth, handleMetrics } from './routes/health.js';
import { handleMetadata } from './routes/packageMetadata.js';
import { handleMetaPassthrough, isAllowedMetaPath } from './routes/passthrough.js';
import { handleTarball } from './routes/tarball.js';
import { TarballDiskCache } from './tarballCache.js';

export interface BuildOptions {
  /** Injectable clock for tests. */
  now?: () => number;
  loggerEnabled?: boolean;
}

export async function buildServer(config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const metrics = new Metrics();
  const upstream = new UpstreamClient(config);
  const metadata = new MetadataService(
    upstream,
    new MemoryCache(config.metadataCacheMaxBytes),
    config,
    metrics,
  );

  let tarballCache: TarballDiskCache | null = null;
  if (config.tarballCacheDir) {
    tarballCache = new TarballDiskCache(config.tarballCacheDir);
    await tarballCache.init();
  }

  const ctx: AppContext = {
    config,
    metrics,
    upstream,
    metadata,
    tarballCache,
    now: opts.now ?? Date.now,
  };

  const app = Fastify({
    exposeHeadRoutes: false,
    bodyLimit: 10 * 1024 * 1024,
    logger:
      opts.loggerEnabled === false
        ? false
        : {
            level: config.logLevel,
            // Never log credentials: npm sends _authToken as an Authorization header.
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["npm-session"]'],
              censor: '[REDACTED]',
            },
          },
    // Per-request access logging is off; the routes emit structured events
    // (metadata requested, tarball allowed/blocked, ...) instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Bodies are only ever streamed through to allowlisted upstream endpoints;
  // never parse them.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err: Error, req, reply) => {
    req.log.error({ err }, 'unhandled error');
    const detail = process.env.NODE_ENV === 'production' ? undefined : err.message;
    reply.code(500).send({ error: detail ?? 'Internal Server Error' });
  });

  const dispatchRead = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = parseRegistryPath(req.raw.url ?? '/');
    switch (parsed.kind) {
      case 'root':
        return reply.code(200).send({
          proxy: 'npm-age-proxy',
          upstream: config.upstreamRegistry,
          minimumAgeHours: config.minAgeHours,
        });
      case 'health':
        return handleHealth(req, reply);
      case 'metrics':
        return handleMetrics(ctx, reply);
      case 'meta':
        if (!isAllowedMetaPath(req.method, parsed.path)) {
          return reply.code(404).send({ error: 'Not Found' });
        }
        return handleMetaPassthrough(ctx, parsed.path, req, reply);
      case 'metadata':
        return handleMetadata(ctx, parsed.name, req, reply);
      case 'tarball':
        return handleTarball(ctx, parsed.name, parsed.filename, req, reply);
      case 'invalid':
        return reply.code(400).send({ error: `invalid request: ${parsed.reason}` });
    }
  };

  app.route({ method: ['GET', 'HEAD'], url: '/', handler: dispatchRead });
  app.route({ method: ['GET', 'HEAD'], url: '/*', handler: dispatchRead });

  // Read-only proxy: publishing and any other mutation is rejected. The only
  // POSTs that pass are npm's read-only-in-spirit audit lookups.
  app.route({
    method: 'POST',
    url: '/*',
    handler: async (req, reply) => {
      const parsed = parseRegistryPath(req.raw.url ?? '/');
      if (parsed.kind === 'meta' && isAllowedMetaPath('POST', parsed.path)) {
        return handleMetaPassthrough(ctx, parsed.path, req, reply);
      }
      return methodNotAllowed(reply);
    },
  });
  for (const url of ['/', '/*']) {
    app.route({
      method: ['PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      url,
      handler: async (_req, reply) => methodNotAllowed(reply),
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'POST') return methodNotAllowed(reply);
    reply.code(404).send({ error: 'Not Found' });
  });

  app.addHook('onClose', async () => {
    await upstream.close();
  });

  return app;
}

function methodNotAllowed(reply: FastifyReply): FastifyReply {
  return reply.code(405).send({ error: 'this registry proxy is read-only' });
}
