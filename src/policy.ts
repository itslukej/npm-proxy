import semver from 'semver';

import type { Config } from './config.js';

/** The subset of a packument this proxy cares about. Everything else is passed through untouched. */
export interface Packument {
  name?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
  time?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackumentVersion {
  dist?: { tarball?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type PolicyConfig = Pick<
  Config,
  'minAgeMs' | 'minAgeHours' | 'excludePackages' | 'excludeVersions' | 'publicRegistryUrl'
>;

export type Decision =
  | { allowed: true; reason: 'old-enough'; publishedAt: string; ageMs: number }
  | { allowed: true; reason: 'excluded-package' | 'excluded-version' }
  | { allowed: false; reason: 'too-young'; publishedAt: string; ageMs: number }
  | { allowed: false; reason: 'unknown-publish-time' }
  | { allowed: false; reason: 'unknown-version' };

/**
 * Decide whether a single version passes the age policy.
 *
 * Fails closed: a version is allowed only if it is explicitly excluded from
 * the policy, or it exists in the packument's `versions` map AND its
 * publication timestamp is present, parseable, and older than the cutoff.
 * `versionExists` is what keeps the `time` map's special entries ("created",
 * "modified", "unpublished") from ever being treated as versions — a version
 * key that isn't in `versions` is `unknown-version`, never checked against
 * `time`. Exclusions are checked first so an excluded version absent from a
 * (possibly stale) packument can still be fetched upstream.
 */
export function decideVersion(
  name: string,
  version: string,
  time: Record<string, string> | undefined,
  versionExists: boolean,
  policy: PolicyConfig,
  now: number,
): Decision {
  if (policy.excludePackages.has(name)) {
    return { allowed: true, reason: 'excluded-package' };
  }
  if (policy.excludeVersions.has(`${name}@${version}`)) {
    return { allowed: true, reason: 'excluded-version' };
  }
  if (!versionExists) {
    return { allowed: false, reason: 'unknown-version' };
  }
  const raw = time?.[version];
  if (typeof raw !== 'string') {
    return { allowed: false, reason: 'unknown-publish-time' };
  }
  const publishedAt = Date.parse(raw);
  if (Number.isNaN(publishedAt)) {
    return { allowed: false, reason: 'unknown-publish-time' };
  }
  const ageMs = now - publishedAt;
  if (ageMs >= policy.minAgeMs) {
    return { allowed: true, reason: 'old-enough', publishedAt: raw, ageMs };
  }
  return { allowed: false, reason: 'too-young', publishedAt: raw, ageMs };
}

/** Human-readable 403 message for a blocked tarball/version. */
export function blockedMessage(name: string, version: string, decision: Decision, policy: PolicyConfig): string {
  const minimum = `Minimum package age is ${formatHours(policy.minAgeHours)}.`;
  if (decision.allowed === false && decision.reason === 'too-young') {
    const ageDays = (decision.ageMs / 86_400_000).toFixed(1);
    return `${name}@${version} is only ${ageDays} days old. ${minimum}`;
  }
  return `${name}@${version} has no reliable publication timestamp; the age policy fails closed. ${minimum}`;
}

function formatHours(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24} days (${hours}h)`;
  return `${hours} hours`;
}

/**
 * Rebuild a tarball URL against the proxy's public base URL. The filename is
 * reconstructed from name+version (the registry invariant) rather than
 * trusted from the upstream URL.
 */
export function proxyTarballUrl(publicRegistryUrl: string, name: string, version: string): string {
  const unscoped = name.split('/').pop() ?? name;
  const namePath = name
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
    .replace(/^%40/, '@');
  return `${publicRegistryUrl}/${namePath}/-/${unscoped}-${version}.tgz`;
}

export type FilterResult =
  | { kind: 'ok'; doc: Packument; blockedCount: number; allowedCount: number }
  | { kind: 'empty'; blockedCount: number };

/**
 * Apply the age policy to a raw upstream packument:
 *  - drop versions that fail the policy (fail closed on missing timestamps)
 *  - filter the served `time` map so blocked versions don't leak
 *  - rewrite dist.tarball of surviving versions to the proxy
 *  - rewrite dist-tags so no tag points at a blocked version
 */
export function filterPackument(
  raw: Packument,
  name: string,
  policy: PolicyConfig,
  now: number,
): FilterResult {
  const versions = raw.versions ?? {};
  const time = raw.time;

  const allowedVersions: Record<string, PackumentVersion> = {};
  let blockedCount = 0;

  for (const [version, manifest] of Object.entries(versions)) {
    // Upstream is untrusted: a malformed (non-object) manifest entry is
    // blocked rather than crashing metadata for the whole package.
    if (manifest === null || typeof manifest !== 'object') {
      blockedCount += 1;
      continue;
    }
    const decision = decideVersion(name, version, time, true, policy, now);
    if (!decision.allowed) {
      blockedCount += 1;
      continue;
    }
    const rewritten: PackumentVersion = { ...manifest };
    if (manifest.dist && typeof manifest.dist === 'object') {
      rewritten.dist = { ...manifest.dist, tarball: proxyTarballUrl(policy.publicRegistryUrl, name, version) };
    }
    allowedVersions[version] = rewritten;
  }

  const allowedKeys = Object.keys(allowedVersions);
  if (allowedKeys.length === 0) {
    return { kind: 'empty', blockedCount };
  }

  const distTags: Record<string, string> = {};
  for (const [tag, target] of Object.entries(raw['dist-tags'] ?? {})) {
    if (typeof target === 'string' && allowedVersions[target]) {
      distTags[tag] = target;
    }
    // Tags pointing at blocked versions are dropped; `latest` is repaired below.
  }
  if (!distTags.latest) {
    const fallback = pickLatest(allowedKeys);
    if (fallback) distTags.latest = fallback;
  }

  const filtered: Packument = { ...raw, versions: allowedVersions, 'dist-tags': distTags };
  if (time && typeof time === 'object') {
    const filteredTime: Record<string, string> = {};
    for (const special of ['created', 'modified']) {
      const value = time[special];
      if (typeof value === 'string') filteredTime[special] = value;
    }
    for (const version of allowedKeys) {
      const value = time[version];
      if (typeof value === 'string') filteredTime[version] = value;
    }
    filtered.time = filteredTime;
  }

  return { kind: 'ok', doc: filtered, blockedCount, allowedCount: allowedKeys.length };
}

/**
 * Highest allowed stable version by semver order; falls back to the highest
 * prerelease, then (for legacy packages with non-semver version strings) the
 * last key. Never lexicographic.
 */
function pickLatest(allowed: string[]): string | undefined {
  const valid = allowed.filter((v) => semver.valid(v) !== null);
  const stable = valid.filter((v) => !semver.prerelease(v));
  if (stable.length > 0) return semver.rsort([...stable])[0];
  if (valid.length > 0) return semver.rsort([...valid])[0];
  return allowed[allowed.length - 1];
}
