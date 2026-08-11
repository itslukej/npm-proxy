import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, daysAgo, makePackument } from './helpers/fixtures.js';
import { startMockRegistry, type MockRegistry } from './helpers/mockRegistry.js';

const TARBALL_BYTES = Buffer.from('fake-tarball-bytes-' + 'x'.repeat(64));

let upstream: MockRegistry;
let app: FastifyInstance | null = null;

beforeEach(async () => {
  upstream = await startMockRegistry();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await upstream.close();
});

function serveTarballPackage(name: string, versions: Record<string, string | null>): void {
  upstream.route(`/${name}`, { body: JSON.stringify(makePackument(name, versions)) });
  const unscoped = name.split('/').pop()!;
  for (const version of Object.keys(versions)) {
    upstream.route(`/${name}/-/${unscoped}-${version}.tgz`, {
      body: TARBALL_BYTES,
      contentType: 'application/octet-stream',
    });
  }
}

describe('tarball downloads', () => {
  it('streams tarballs of old versions from the upstream', async () => {
    serveTarballPackage('foo', { '1.0.0': daysAgo(100) });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/foo/-/foo-1.0.0.tgz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.rawPayload.equals(TARBALL_BYTES)).toBe(true);
  });

  it('returns 403 with a useful message for young versions', async () => {
    serveTarballPackage('foo', { '1.2.3': daysAgo(2.4) });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/foo/-/foo-1.2.3.tgz' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('foo@1.2.3 is only 2.4 days old');
    expect(res.json().error).toContain('Minimum package age is 7 days');
    // The upstream tarball must never have been touched.
    expect(upstream.requestCount('/foo/-/')).toBe(0);
  });

  it('fails closed when the version has no publication timestamp', async () => {
    serveTarballPackage('foo', { '3.0.0': null });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/foo/-/foo-3.0.0.tgz' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('no reliable publication timestamp');
  });

  it('handles scoped tarballs, encoded or not', async () => {
    serveTarballPackage('@scope/bar', { '2.0.0': daysAgo(60) });
    app = await buildTestApp(upstream.url);

    for (const url of ['/@scope/bar/-/bar-2.0.0.tgz', '/@scope%2fbar/-/bar-2.0.0.tgz']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.rawPayload.equals(TARBALL_BYTES)).toBe(true);
    }
  });

  it('handles prerelease versions (dashes in the version)', async () => {
    serveTarballPackage('foo', { '1.0.0-beta.1': daysAgo(60) });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/foo/-/foo-1.0.0-beta.1.tgz' });
    expect(res.statusCode).toBe(200);
  });

  it('lets excluded versions through regardless of age', async () => {
    serveTarballPackage('hotfix', { '9.9.9': daysAgo(0.01) });
    app = await buildTestApp(upstream.url, { MIN_AGE_EXCLUDE_VERSIONS: 'hotfix@9.9.9' });

    const res = await app.inject({ method: 'GET', url: '/hotfix/-/hotfix-9.9.9.tgz' });
    expect(res.statusCode).toBe(200);
  });

  it('lets excluded packages through regardless of age', async () => {
    serveTarballPackage('@my-company/foo', { '1.0.0': daysAgo(0.01) });
    app = await buildTestApp(upstream.url, { MIN_AGE_EXCLUDE_PACKAGES: '@my-company/foo' });

    const res = await app.inject({ method: 'GET', url: '/@my-company/foo/-/foo-1.0.0.tgz' });
    expect(res.statusCode).toBe(200);
  });

  it('404s tarballs whose filename does not match the package', async () => {
    serveTarballPackage('foo', { '1.0.0': daysAgo(100) });
    app = await buildTestApp(upstream.url);

    expect((await app.inject({ method: 'GET', url: '/foo/-/bar-1.0.0.tgz' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/foo/-/foo-0.9.9.tgz' })).statusCode).toBe(404);
  });

  it('404s tarballs of unknown packages', async () => {
    app = await buildTestApp(upstream.url);
    expect((await app.inject({ method: 'GET', url: '/ghost/-/ghost-1.0.0.tgz' })).statusCode).toBe(404);
  });

  it('404s unpublished versions (present in time, absent from versions) without touching upstream tarballs', async () => {
    const doc = makePackument('foo', { '1.0.0': daysAgo(100) });
    (doc.time as Record<string, string>)['2.0.0'] = daysAgo(50); // unpublished leftover
    upstream.route('/foo', { body: JSON.stringify(doc) });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/foo/-/foo-2.0.0.tgz' });
    expect(res.statusCode).toBe(404);
    expect(upstream.requestCount('/foo/-/')).toBe(0);
  });

  it('404s (not 403s) version keys matching time-map special entries', async () => {
    serveTarballPackage('foo', { '1.0.0': daysAgo(100) });
    app = await buildTestApp(upstream.url);

    // time.modified is always recent; a naive lookup would 403 "0.0 days old".
    expect((await app.inject({ method: 'GET', url: '/foo/-/foo-modified.tgz' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/foo/-/foo-created.tgz' })).statusCode).toBe(404);
  });

  it('answers HEAD for an allowed tarball without a body', async () => {
    serveTarballPackage('foo', { '1.0.0': daysAgo(100) });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'HEAD', url: '/foo/-/foo-1.0.0.tgz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('blocks HEAD for a young tarball with 403', async () => {
    serveTarballPackage('foo', { '1.2.3': daysAgo(2) });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'HEAD', url: '/foo/-/foo-1.2.3.tgz' });
    expect(res.statusCode).toBe(403);
    expect(upstream.requestCount('/foo/-/')).toBe(0);
  });

  it('maps upstream failures on HEAD to 502, never 404', async () => {
    serveTarballPackage('foo', { '1.0.0': daysAgo(100) });
    upstream.route('HEAD /foo/-/foo-1.0.0.tgz', { status: 500, body: '' });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'HEAD', url: '/foo/-/foo-1.0.0.tgz' });
    expect(res.statusCode).toBe(502);
  });

  it('caches allowed tarballs on disk and serves repeats from the cache', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'npm-proxy-test-'));
    serveTarballPackage('foo', { '1.0.0': daysAgo(100) });
    app = await buildTestApp(upstream.url, { TARBALL_CACHE_DIR: dir });

    const first = await app.inject({ method: 'GET', url: '/foo/-/foo-1.0.0.tgz' });
    expect(first.statusCode).toBe(200);

    // The tee finishes asynchronously after the response completes.
    await waitFor(async () => (await readdir(dir)).some((f) => !f.endsWith('.tmp')));

    const second = await app.inject({ method: 'GET', url: '/foo/-/foo-1.0.0.tgz' });
    expect(second.statusCode).toBe(200);
    expect(second.rawPayload.equals(TARBALL_BYTES)).toBe(true);
    expect(upstream.requestCount('/foo/-/')).toBe(1);
  });

  it('does not follow upstream redirects to foreign origins', async () => {
    upstream.route('/evil', { body: JSON.stringify(makePackument('evil', { '1.0.0': daysAgo(100) })) });
    upstream.route('/evil/-/evil-1.0.0.tgz', { redirectTo: 'http://attacker.example.com/x.tgz' });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/evil/-/evil-1.0.0.tgz' });
    expect(res.statusCode).toBe(502);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}
