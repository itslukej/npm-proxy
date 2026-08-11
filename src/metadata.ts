import type { CacheStore } from './cache.js';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import { encodedNamePath } from './paths.js';
import type { Packument } from './policy.js';
import { UpstreamClient, UpstreamError } from './registry.js';

export type PackumentResult = { kind: 'ok'; doc: Packument } | { kind: 'not-found' };

type CacheValue = { kind: 'ok'; doc: Packument } | { kind: 'not-found' };

/**
 * Fetches RAW upstream packuments with caching. Policy is deliberately NOT
 * applied here: caching the unfiltered document means versions age past the
 * threshold without waiting for TTL expiry, and the metadata and tarball
 * routes share one cache entry.
 *
 * Successful lookups are cached for the configured TTL; upstream 404s are
 * negative-cached briefly; upstream failures (5xx, timeouts, bad JSON) are
 * never cached.
 */
export class MetadataService {
  private inflight = new Map<string, Promise<PackumentResult>>();

  constructor(
    private readonly upstream: UpstreamClient,
    private readonly cache: CacheStore<CacheValue>,
    private readonly config: Pick<Config, 'metadataCacheTtlMs' | 'negativeCacheTtlMs'>,
    private readonly metrics: Metrics,
  ) {}

  /** @throws UpstreamError when the upstream cannot be consulted. */
  async getPackument(name: string): Promise<PackumentResult> {
    const cached = await this.cache.get(name);
    if (cached) {
      this.metrics.inc('metadata_cache_hits_total');
      return cached;
    }
    this.metrics.inc('metadata_cache_misses_total');

    // Collapse concurrent fetches for the same package into one upstream call.
    const pending = this.inflight.get(name);
    if (pending) return pending;

    const fetch = this.fetchAndCache(name).finally(() => this.inflight.delete(name));
    this.inflight.set(name, fetch);
    return fetch;
  }

  private async fetchAndCache(name: string): Promise<PackumentResult> {
    let result: { statusCode: number; json?: unknown };
    try {
      result = await this.upstream.fetchJson('/' + encodedNamePath(name));
    } catch (err) {
      this.metrics.inc('upstream_errors_total');
      throw err;
    }

    if (result.statusCode === 404) {
      await this.cache.set(name, { kind: 'not-found' }, this.config.negativeCacheTtlMs, 64);
      return { kind: 'not-found' };
    }
    if (result.statusCode !== 200) {
      this.metrics.inc('upstream_errors_total');
      throw new UpstreamError('status', `upstream returned HTTP ${result.statusCode}`, result.statusCode);
    }

    const doc = result.json;
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      this.metrics.inc('upstream_errors_total');
      throw new UpstreamError('bad-json', 'upstream packument is not a JSON object');
    }

    const value: CacheValue = { kind: 'ok', doc: doc as Packument };
    // Rough size estimate for the byte-capped LRU; ~2 bytes/char is close
    // enough without re-serializing the document.
    const sizeBytes = JSON.stringify(doc).length;
    await this.cache.set(name, value, this.config.metadataCacheTtlMs, sizeBytes);
    return value;
  }
}
