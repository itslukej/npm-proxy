import { describe, expect, it } from 'vitest';

import { parseRegistryPath, versionFromTarballFilename } from '../src/paths.js';

describe('parseRegistryPath', () => {
  it('parses unscoped metadata', () => {
    expect(parseRegistryPath('/express')).toEqual({ kind: 'metadata', name: 'express' });
    expect(parseRegistryPath('/lodash?write=true')).toEqual({ kind: 'metadata', name: 'lodash' });
  });

  it('parses legacy mixed-case names', () => {
    expect(parseRegistryPath('/JSONStream')).toEqual({ kind: 'metadata', name: 'JSONStream' });
  });

  it('parses scoped metadata in all encodings npm clients use', () => {
    const expected = { kind: 'metadata', name: '@types/node' };
    expect(parseRegistryPath('/@types%2fnode')).toEqual(expected);
    expect(parseRegistryPath('/@types%2Fnode')).toEqual(expected);
    expect(parseRegistryPath('/@types/node')).toEqual(expected);
  });

  it('parses unscoped tarball paths', () => {
    expect(parseRegistryPath('/foo/-/foo-1.2.3.tgz')).toEqual({
      kind: 'tarball',
      name: 'foo',
      filename: 'foo-1.2.3.tgz',
    });
  });

  it('parses scoped tarball paths (encoded and not)', () => {
    const expected = { kind: 'tarball', name: '@scope/foo', filename: 'foo-1.2.3.tgz' };
    expect(parseRegistryPath('/@scope/foo/-/foo-1.2.3.tgz')).toEqual(expected);
    expect(parseRegistryPath('/@scope%2ffoo/-/foo-1.2.3.tgz')).toEqual(expected);
  });

  it('routes /health and /metrics', () => {
    expect(parseRegistryPath('/health')).toEqual({ kind: 'health' });
    expect(parseRegistryPath('/metrics')).toEqual({ kind: 'metrics' });
  });

  it('routes meta endpoints', () => {
    expect(parseRegistryPath('/-/ping')).toEqual({ kind: 'meta', path: '/-/ping' });
    expect(parseRegistryPath('/-/npm/v1/security/audits/quick')).toEqual({
      kind: 'meta',
      path: '/-/npm/v1/security/audits/quick',
    });
  });

  it('rejects traversal and malformed input', () => {
    expect(parseRegistryPath('/../etc/passwd').kind).toBe('invalid');
    expect(parseRegistryPath('/foo/-/%2e%2e%2fescape.tgz').kind).toBe('invalid');
    expect(parseRegistryPath('/foo/-/..%2f..%2fescape.tgz').kind).toBe('invalid');
    expect(parseRegistryPath('/%zz').kind).toBe('invalid');
    expect(parseRegistryPath('/foo%00bar').kind).toBe('invalid');
    expect(parseRegistryPath('/not@a@name!').kind).toBe('invalid');
  });
});

describe('versionFromTarballFilename', () => {
  it('extracts plain versions', () => {
    expect(versionFromTarballFilename('foo', 'foo-1.2.3.tgz')).toBe('1.2.3');
  });

  it('extracts prerelease versions containing dashes', () => {
    expect(versionFromTarballFilename('foo', 'foo-1.0.0-beta.1.tgz')).toBe('1.0.0-beta.1');
  });

  it('handles package names containing dashes and digits', () => {
    expect(versionFromTarballFilename('socket.io-client', 'socket.io-client-4.7.2.tgz')).toBe('4.7.2');
  });

  it('uses the unscoped name for scoped packages', () => {
    expect(versionFromTarballFilename('@types/node', 'node-20.1.0.tgz')).toBe('20.1.0');
  });

  it('rejects filenames that do not match the package', () => {
    expect(versionFromTarballFilename('foo', 'bar-1.2.3.tgz')).toBeNull();
    expect(versionFromTarballFilename('foo', 'foo-.tgz')).toBeNull();
  });
});
