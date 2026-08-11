import validateName from 'validate-npm-package-name';

export type ParsedPath =
  | { kind: 'root' }
  | { kind: 'health' }
  | { kind: 'metrics' }
  | { kind: 'meta'; path: string } // registry meta endpoints under /-/
  | { kind: 'metadata'; name: string }
  | { kind: 'tarball'; name: string; filename: string }
  | { kind: 'invalid'; reason: string };

const FILENAME_RE = /^[A-Za-z0-9._+-]+\.tgz$/;
const META_PATH_RE = /^\/-\/[A-Za-z0-9._/-]*$/;

/**
 * Parse the raw (still-encoded) request path into a registry route.
 *
 * npm clients encode scoped names inconsistently (`/@scope%2fpkg`,
 * `/@scope%2Fpkg`, `/@scope/pkg`), so each raw segment is decoded
 * individually and re-split on any slashes the decode reveals.
 */
export function parseRegistryPath(rawUrl: string): ParsedPath {
  const q = rawUrl.indexOf('?');
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  if (rawPath === '' || rawPath === '/') return { kind: 'root' };

  const segments: string[] = [];
  for (const rawSeg of rawPath.split('/')) {
    if (rawSeg === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      return { kind: 'invalid', reason: 'malformed percent-encoding' };
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
      return { kind: 'invalid', reason: 'illegal characters in path' };
    }
    for (const part of decoded.split('/')) {
      if (part === '') return { kind: 'invalid', reason: 'empty path segment' };
      segments.push(part);
    }
  }

  if (segments.some((s) => s === '.' || s === '..')) {
    return { kind: 'invalid', reason: 'path traversal attempt' };
  }
  if (segments.length === 0) return { kind: 'root' };

  if (segments.length === 1) {
    if (segments[0] === 'health') return { kind: 'health' };
    if (segments[0] === 'metrics') return { kind: 'metrics' };
  }

  // Registry meta endpoints (/-/ping, /-/npm/v1/security/..., ...). The one
  // ambiguity is the real npm package named "-": a bare /- is metadata.
  if (segments[0] === '-' && segments.length > 1) {
    const metaPath = '/-/' + segments.slice(1).join('/');
    if (!META_PATH_RE.test(metaPath)) return { kind: 'invalid', reason: 'illegal meta path' };
    return { kind: 'meta', path: metaPath };
  }

  // Tarballs: /{name}/-/{file}.tgz or /@scope/{name}/-/{file}.tgz
  if (segments.length === 3 && segments[1] === '-') {
    return asTarball(segments[0]!, segments[2]!);
  }
  if (segments.length === 4 && segments[0]!.startsWith('@') && segments[2] === '-') {
    return asTarball(`${segments[0]}/${segments[1]}`, segments[3]!);
  }

  // Metadata: /{name} or /@scope/{name}
  if (segments.length === 1) {
    return asMetadata(segments[0]!);
  }
  if (segments.length === 2 && segments[0]!.startsWith('@')) {
    return asMetadata(`${segments[0]}/${segments[1]}`);
  }

  return { kind: 'invalid', reason: 'unrecognized path' };
}

function asMetadata(name: string): ParsedPath {
  if (!isValidPackageName(name)) return { kind: 'invalid', reason: 'invalid package name' };
  return { kind: 'metadata', name };
}

function asTarball(name: string, filename: string): ParsedPath {
  if (!isValidPackageName(name)) return { kind: 'invalid', reason: 'invalid package name' };
  if (!FILENAME_RE.test(filename)) return { kind: 'invalid', reason: 'invalid tarball filename' };
  return { kind: 'tarball', name, filename };
}

/**
 * Accepts names valid for old packages too (legacy mixed-case names like
 * JSONStream are exactly what a legacy-client proxy must serve).
 */
export function isValidPackageName(name: string): boolean {
  const result = validateName(name);
  return result.validForNewPackages || result.validForOldPackages;
}

/**
 * Extract the version from a tarball filename given the registry invariant
 * `filename === "<unscoped-name>-<version>.tgz"`. Returns null when the
 * filename does not match the package. No "last dash" heuristics — prerelease
 * versions and package names both legally contain dashes.
 */
export function versionFromTarballFilename(name: string, filename: string): string | null {
  const unscoped = name.split('/').pop() ?? name;
  const prefix = `${unscoped}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith('.tgz')) return null;
  const version = filename.slice(prefix.length, -'.tgz'.length);
  return version.length > 0 ? version : null;
}

/** Encoded upstream path for a package name (keeps the literal @ of scopes). */
export function encodedNamePath(name: string): string {
  return name
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
    .replace(/^%40/, '@');
}
