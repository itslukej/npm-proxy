import type { CacheStore } from './cache.js';
import type { Config } from './config.js';
import type { MetadataService } from './metadata.js';
import type { Metrics } from './metrics.js';
import type { UpstreamClient } from './registry.js';
import type { TarballDiskCache } from './tarballCache.js';

/** A ready-to-send filtered metadata response (see routes/packageMetadata.ts). */
export interface FilteredMetadata {
  body: string;
  etag: string;
}

/** Everything route handlers need, threaded through explicitly so an auth layer can be inserted later without global state. */
export interface AppContext {
  config: Config;
  metrics: Metrics;
  upstream: UpstreamClient;
  metadata: MetadataService;
  /** Short-TTL cache of serialized filtered responses; the expensive filter/stringify/hash runs once per package per TTL window, not per request. */
  filteredCache: CacheStore<FilteredMetadata>;
  tarballCache: TarballDiskCache | null;
  now: () => number;
}
