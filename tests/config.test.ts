import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, parseVersionException } from '../src/config.js';

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(3000);
    expect(c.upstreamRegistry).toBe('https://registry.npmjs.org');
    expect(c.minAgeHours).toBe(168);
    expect(c.metadataCacheTtlMs).toBe(300_000);
  });

  it('MIN_PACKAGE_AGE_HOURS wins over MIN_PACKAGE_AGE_DAYS', () => {
    const c = loadConfig({ MIN_PACKAGE_AGE_DAYS: '7', MIN_PACKAGE_AGE_HOURS: '12' });
    expect(c.minAgeHours).toBe(12);
    expect(c.minAgeMs).toBe(12 * 3_600_000);
  });

  it('rejects invalid URLs and non-http protocols', () => {
    expect(() => loadConfig({ UPSTREAM_REGISTRY: 'not-a-url' })).toThrow(ConfigError);
    expect(() => loadConfig({ UPSTREAM_REGISTRY: 'ftp://example.com' })).toThrow(ConfigError);
  });

  it('rejects malformed numbers', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ MIN_PACKAGE_AGE_DAYS: '-1' })).toThrow(ConfigError);
  });

  it('parses exclusion lists including scoped versions', () => {
    const c = loadConfig({
      MIN_AGE_EXCLUDE_PACKAGES: '@my-company/foo, emergency-package',
      MIN_AGE_EXCLUDE_VERSIONS: 'foo@1.2.3, @scope/bar@4.5.6',
    });
    expect(c.excludePackages).toEqual(new Set(['@my-company/foo', 'emergency-package']));
    expect(c.excludeVersions).toEqual(new Set(['foo@1.2.3', '@scope/bar@4.5.6']));
  });

  it('rejects malformed version exceptions', () => {
    expect(() => loadConfig({ MIN_AGE_EXCLUDE_VERSIONS: 'just-a-name' })).toThrow(ConfigError);
  });
});

describe('parseVersionException', () => {
  it('splits on the last @ so scoped names parse', () => {
    expect(parseVersionException('@scope/bar@4.5.6')).toEqual({ name: '@scope/bar', version: '4.5.6' });
    expect(parseVersionException('foo@1.2.3')).toEqual({ name: 'foo', version: '1.2.3' });
    expect(parseVersionException('@scope/bar')).toBeNull();
  });
});
