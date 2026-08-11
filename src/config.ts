export interface Config {
  port: number;
  host: string;
  /** Upstream registry origin, no trailing slash. */
  upstreamRegistry: string;
  /** Public base URL of this proxy (used to rewrite dist.tarball), no trailing slash. */
  publicRegistryUrl: string;
  /** Minimum package age in milliseconds. */
  minAgeMs: number;
  /** Minimum package age in hours (for messages/logs). */
  minAgeHours: number;
  metadataCacheTtlMs: number;
  /** How long to cache upstream 404s. */
  negativeCacheTtlMs: number;
  /** Max decompressed metadata body size accepted from upstream. */
  maxMetadataBytes: number;
  /** Max bytes held by the in-memory metadata cache. */
  metadataCacheMaxBytes: number;
  upstreamTimeoutMs: number;
  logLevel: string;
  /** Package names that bypass the age policy entirely. */
  excludePackages: Set<string>;
  /** Exact "name@version" pairs that bypass the age policy. */
  excludeVersions: Set<string>;
  /** Directory for the on-disk tarball cache; null disables it. */
  tarballCacheDir: string | null;
}

export class ConfigError extends Error {}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function numberVar(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

function urlVar(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL, got "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http or https, got "${raw}"`);
  }
  if (url.search || url.hash) {
    throw new ConfigError(`${name} must not contain a query string or fragment`);
  }
  // Normalize: strip trailing slashes from the path.
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

function listVar(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse "name@version" (including "@scope/name@version") by splitting on the
 * LAST "@", so scoped names parse correctly.
 */
export function parseVersionException(entry: string): { name: string; version: string } | null {
  const at = entry.lastIndexOf('@');
  if (at <= 0) return null; // no "@", or the entry is just a scope prefix
  const name = entry.slice(0, at);
  const version = entry.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = intVar(env, 'PORT', 3000, 1);
  if (port > 65535) throw new ConfigError(`PORT must be <= 65535, got ${port}`);

  const upstreamRegistry = urlVar(env, 'UPSTREAM_REGISTRY', 'https://registry.npmjs.org');
  const publicRegistryUrl = urlVar(env, 'PUBLIC_REGISTRY_URL', `http://localhost:${port}`);

  // MIN_PACKAGE_AGE_HOURS wins over MIN_PACKAGE_AGE_DAYS when both are set.
  const hours = numberVar(env, 'MIN_PACKAGE_AGE_HOURS');
  const days = numberVar(env, 'MIN_PACKAGE_AGE_DAYS');
  const minAgeHours = hours !== undefined ? hours : (days !== undefined ? days : 7) * 24;
  const minAgeMs = Math.round(minAgeHours * 60 * 60 * 1000);

  const excludeVersions = new Set<string>();
  for (const entry of listVar(env, 'MIN_AGE_EXCLUDE_VERSIONS')) {
    const parsed = parseVersionException(entry);
    if (!parsed) {
      throw new ConfigError(`MIN_AGE_EXCLUDE_VERSIONS entry "${entry}" is not in name@version form`);
    }
    excludeVersions.add(`${parsed.name}@${parsed.version}`);
  }

  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  const validLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (!validLevels.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${validLevels.join(', ')}, got "${logLevel}"`);
  }

  return {
    port,
    host: env.HOST?.trim() || '0.0.0.0',
    upstreamRegistry,
    publicRegistryUrl,
    minAgeMs,
    minAgeHours,
    metadataCacheTtlMs: intVar(env, 'METADATA_CACHE_TTL_SECONDS', 300) * 1000,
    negativeCacheTtlMs: intVar(env, 'NEGATIVE_CACHE_TTL_SECONDS', 60) * 1000,
    maxMetadataBytes: intVar(env, 'MAX_METADATA_BYTES', 64 * 1024 * 1024, 1024),
    metadataCacheMaxBytes: intVar(env, 'METADATA_CACHE_MAX_BYTES', 256 * 1024 * 1024, 0),
    upstreamTimeoutMs: intVar(env, 'UPSTREAM_TIMEOUT_MS', 10_000, 100),
    logLevel,
    excludePackages: new Set(listVar(env, 'MIN_AGE_EXCLUDE_PACKAGES')),
    excludeVersions,
    tarballCacheDir: env.TARBALL_CACHE_DIR?.trim() || null,
  };
}
