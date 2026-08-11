import type { FastifyInstance } from 'fastify';

import { loadConfig } from '../../src/config.js';
import type { Packument } from '../../src/policy.js';
import { buildServer } from '../../src/server.js';

export const PUBLIC_URL = 'https://npm-proxy.example.com';

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Build a packument. `versions` maps version -> publish time ISO string, or
 * null to omit the version from the `time` map (registry inconsistency).
 */
export function makePackument(
  name: string,
  versions: Record<string, string | null>,
  distTags?: Record<string, string>,
): Packument {
  const unscoped = name.split('/').pop()!;
  const versionEntries: Record<string, unknown> = {};
  const time: Record<string, string> = {
    created: '2015-01-01T00:00:00.000Z',
    modified: new Date().toISOString(),
  };
  for (const [version, published] of Object.entries(versions)) {
    versionEntries[version] = {
      name,
      version,
      dist: {
        tarball: `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`,
        shasum: 'abc123',
      },
    };
    if (published !== null) time[version] = published;
  }
  return {
    name,
    'dist-tags': distTags ?? { latest: Object.keys(versions).at(-1)! },
    versions: versionEntries as Packument['versions'],
    time,
  };
}

export async function buildTestApp(
  upstreamUrl: string,
  env: Record<string, string> = {},
): Promise<FastifyInstance> {
  const config = loadConfig({
    UPSTREAM_REGISTRY: upstreamUrl,
    PUBLIC_REGISTRY_URL: PUBLIC_URL,
    UPSTREAM_TIMEOUT_MS: '500',
    ...env,
  });
  return buildServer(config, { loggerEnabled: false });
}
