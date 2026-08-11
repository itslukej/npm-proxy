import type { Config } from './config.js';
import type { MetadataService } from './metadata.js';
import type { Metrics } from './metrics.js';
import type { UpstreamClient } from './registry.js';
import type { TarballDiskCache } from './tarballCache.js';

/** Everything route handlers need, threaded through explicitly so an auth layer can be inserted later without global state. */
export interface AppContext {
  config: Config;
  metrics: Metrics;
  upstream: UpstreamClient;
  metadata: MetadataService;
  tarballCache: TarballDiskCache | null;
  now: () => number;
}
