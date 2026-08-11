import { describe, expect, it } from 'vitest';

import {
  blockedMessage,
  decideVersion,
  filterPackument,
  proxyTarballUrl,
  type PolicyConfig,
} from '../src/policy.js';
import { daysAgo, makePackument, PUBLIC_URL } from './helpers/fixtures.js';

const NOW = Date.now();

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    minAgeMs: 7 * 86_400_000,
    minAgeHours: 168,
    excludePackages: new Set<string>(),
    excludeVersions: new Set<string>(),
    publicRegistryUrl: PUBLIC_URL,
    ...overrides,
  };
}

describe('decideVersion', () => {
  it('allows versions older than the minimum age', () => {
    const d = decideVersion('foo', '1.0.0', { '1.0.0': daysAgo(30) }, policy(), NOW);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('old-enough');
  });

  it('blocks versions younger than the minimum age', () => {
    const d = decideVersion('foo', '1.0.0', { '1.0.0': daysAgo(2) }, policy(), NOW);
    expect(d).toMatchObject({ allowed: false, reason: 'too-young' });
  });

  it('fails closed when the version has no time entry', () => {
    const d = decideVersion('foo', '1.0.0', {}, policy(), NOW);
    expect(d).toMatchObject({ allowed: false, reason: 'unknown-publish-time' });
  });

  it('fails closed when the time map is missing entirely', () => {
    expect(decideVersion('foo', '1.0.0', undefined, policy(), NOW).allowed).toBe(false);
  });

  it('fails closed on an unparseable timestamp', () => {
    const d = decideVersion('foo', '1.0.0', { '1.0.0': 'not-a-date' }, policy(), NOW);
    expect(d).toMatchObject({ allowed: false, reason: 'unknown-publish-time' });
  });

  it('never treats time special keys as versions', () => {
    const d = decideVersion('foo', 'created', { created: daysAgo(3000) }, policy(), NOW);
    // "created" is looked up as a version string; it happens to exist here,
    // but real packuments never have a version literally named "created" in
    // `versions` — this just documents that lookup is by version key only.
    expect(d.allowed).toBe(true);
  });

  it('allows an excluded package regardless of age', () => {
    const p = policy({ excludePackages: new Set(['@my-company/foo']) });
    const d = decideVersion('@my-company/foo', '1.0.0', { '1.0.0': daysAgo(0.1) }, p, NOW);
    expect(d).toMatchObject({ allowed: true, reason: 'excluded-package' });
  });

  it('allows an excluded exact version regardless of age (and even without a timestamp)', () => {
    const p = policy({ excludeVersions: new Set(['@scope/bar@4.5.6']) });
    expect(decideVersion('@scope/bar', '4.5.6', {}, p, NOW)).toMatchObject({
      allowed: true,
      reason: 'excluded-version',
    });
    expect(decideVersion('@scope/bar', '4.5.7', {}, p, NOW).allowed).toBe(false);
  });
});

describe('filterPackument', () => {
  it('keeps old versions and drops young ones', () => {
    const doc = makePackument('foo', {
      '1.0.0': daysAgo(400),
      '1.1.0': daysAgo(40),
      '2.0.0': daysAgo(1),
    });
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(result.doc.versions!)).toEqual(['1.0.0', '1.1.0']);
    expect(result.blockedCount).toBe(1);
  });

  it('repoints latest to the highest allowed stable version using semver order', () => {
    // Lexicographically "9.0.0" > "10.0.0"; semver must pick 10.0.0.
    const doc = makePackument(
      'foo',
      { '9.0.0': daysAgo(100), '10.0.0': daysAgo(50), '11.0.0': daysAgo(1) },
      { latest: '11.0.0' },
    );
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.doc['dist-tags']!.latest).toBe('10.0.0');
  });

  it('prefers stable over a newer prerelease when repointing latest', () => {
    const doc = makePackument(
      'foo',
      { '1.0.0': daysAgo(100), '2.0.0-beta.1': daysAgo(50), '2.0.0': daysAgo(2) },
      { latest: '2.0.0' },
    );
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.doc['dist-tags']!.latest).toBe('1.0.0');
  });

  it('falls back to a prerelease latest when no stable version is allowed', () => {
    const doc = makePackument('foo', { '1.0.0-rc.1': daysAgo(60), '1.0.0': daysAgo(1) }, { latest: '1.0.0' });
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.doc['dist-tags']!.latest).toBe('1.0.0-rc.1');
  });

  it('drops non-latest tags that point at blocked versions', () => {
    const doc = makePackument(
      'foo',
      { '1.0.0': daysAgo(100), '2.0.0-beta.1': daysAgo(1) },
      { latest: '1.0.0', beta: '2.0.0-beta.1' },
    );
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.doc['dist-tags']).toEqual({ latest: '1.0.0' });
  });

  it('drops versions with no time entry (fail closed)', () => {
    const doc = makePackument('foo', { '1.0.0': daysAgo(100), '1.5.0': null });
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(result.doc.versions!)).toEqual(['1.0.0']);
  });

  it('filters blocked versions out of the served time map but keeps created/modified', () => {
    const doc = makePackument('foo', { '1.0.0': daysAgo(100), '2.0.0': daysAgo(1) });
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.doc.time).toHaveProperty('created');
    expect(result.doc.time).toHaveProperty('modified');
    expect(result.doc.time).toHaveProperty('1.0.0');
    expect(result.doc.time).not.toHaveProperty('2.0.0');
  });

  it('returns empty when every version is blocked', () => {
    const doc = makePackument('foo', { '1.0.0': daysAgo(1), '2.0.0': daysAgo(2) });
    const result = filterPackument(doc, 'foo', policy(), NOW);
    expect(result).toEqual({ kind: 'empty', blockedCount: 2 });
  });

  it('rewrites tarball URLs to the public proxy URL', () => {
    const doc = makePackument('foo', { '1.0.0': daysAgo(100) });
    const result = filterPackument(doc, 'foo', policy(), NOW);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.doc.versions!['1.0.0']!.dist!.tarball).toBe(`${PUBLIC_URL}/foo/-/foo-1.0.0.tgz`);
    // Other dist fields are untouched (tarball bytes don't change).
    expect(result.doc.versions!['1.0.0']!.dist!.shasum).toBe('abc123');
  });
});

describe('proxyTarballUrl', () => {
  it('builds scoped URLs with a literal @ and unencoded scope slash', () => {
    expect(proxyTarballUrl(PUBLIC_URL, '@types/node', '1.2.3')).toBe(
      `${PUBLIC_URL}/@types/node/-/node-1.2.3.tgz`,
    );
  });
});

describe('blockedMessage', () => {
  it('reports age in days for too-young versions', () => {
    const d = decideVersion('foo', '1.2.3', { '1.2.3': daysAgo(2.4) }, policy(), NOW);
    const msg = blockedMessage('foo', '1.2.3', d, policy());
    expect(msg).toContain('foo@1.2.3 is only 2.4 days old');
    expect(msg).toContain('Minimum package age is 7 days (168h).');
  });
});
