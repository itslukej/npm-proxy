import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, daysAgo, makePackument, PUBLIC_URL } from './helpers/fixtures.js';
import { startMockRegistry, type MockRegistry } from './helpers/mockRegistry.js';

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

function servePackument(name: string, doc: unknown, opts: { gzip?: boolean } = {}): void {
  const path = '/' + name.replace('@', '@'); // scoped upstream paths keep the literal @
  upstream.route(path, { body: JSON.stringify(doc), gzip: opts.gzip });
}

describe('package metadata', () => {
  it('keeps old versions visible and removes young ones', async () => {
    servePackument('express', makePackument('express', { '4.0.0': daysAgo(400), '5.0.0': daysAgo(1) }));
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/express' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const doc = res.json();
    expect(doc.versions).toHaveProperty('4.0.0');
    expect(doc.versions).not.toHaveProperty('5.0.0');
    expect(doc.time).not.toHaveProperty('5.0.0');
  });

  it('rewrites the latest dist-tag to the newest allowed version by semver order', async () => {
    servePackument(
      'foo',
      makePackument(
        'foo',
        { '9.0.0': daysAgo(100), '10.0.0': daysAgo(50), '11.0.0': daysAgo(2) },
        { latest: '11.0.0' },
      ),
    );
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/foo' });
    expect(res.json()['dist-tags'].latest).toBe('10.0.0');
  });

  it('serves scoped packages for every encoding npm clients use', async () => {
    servePackument('@scope/pkg', makePackument('@scope/pkg', { '1.0.0': daysAgo(30) }));
    app = await buildTestApp(upstream.url);

    for (const url of ['/@scope%2fpkg', '/@scope%2Fpkg', '/@scope/pkg']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().name).toBe('@scope/pkg');
    }
  });

  it('rewrites tarball URLs to PUBLIC_REGISTRY_URL (scoped and unscoped)', async () => {
    servePackument('@scope/pkg', makePackument('@scope/pkg', { '1.0.0': daysAgo(30) }));
    servePackument('foo', makePackument('foo', { '2.1.0': daysAgo(30) }));
    app = await buildTestApp(upstream.url);

    const scoped = (await app.inject({ method: 'GET', url: '/@scope%2fpkg' })).json();
    expect(scoped.versions['1.0.0'].dist.tarball).toBe(`${PUBLIC_URL}/@scope/pkg/-/pkg-1.0.0.tgz`);

    const plain = (await app.inject({ method: 'GET', url: '/foo' })).json();
    expect(plain.versions['2.1.0'].dist.tarball).toBe(`${PUBLIC_URL}/foo/-/foo-2.1.0.tgz`);
  });

  it('returns an npm-style 404 when no version satisfies the policy', async () => {
    servePackument('brand-new', makePackument('brand-new', { '0.0.1': daysAgo(1) }));
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/brand-new' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('minimum package age');
  });

  it('handles gzip-encoded upstream responses', async () => {
    servePackument('gz', makePackument('gz', { '1.0.0': daysAgo(30) }), { gzip: true });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'GET', url: '/gz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions).toHaveProperty('1.0.0');
  });

  it('excluded packages bypass age filtering entirely', async () => {
    servePackument('emergency-package', makePackument('emergency-package', { '1.0.0': daysAgo(0.1) }));
    app = await buildTestApp(upstream.url, { MIN_AGE_EXCLUDE_PACKAGES: 'emergency-package' });

    const res = await app.inject({ method: 'GET', url: '/emergency-package' });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions).toHaveProperty('1.0.0');
  });

  it('excluded exact versions bypass filtering while others stay blocked', async () => {
    servePackument('foo', makePackument('foo', { '1.0.0': daysAgo(100), '1.2.3': daysAgo(1), '1.2.4': daysAgo(1) }));
    app = await buildTestApp(upstream.url, { MIN_AGE_EXCLUDE_VERSIONS: 'foo@1.2.3' });

    const doc = (await app.inject({ method: 'GET', url: '/foo' })).json();
    expect(doc.versions).toHaveProperty('1.2.3');
    expect(doc.versions).not.toHaveProperty('1.2.4');
  });

  it('fails safely on malformed upstream JSON and does not cache the failure', async () => {
    upstream.route('/broken', { body: 'this is {{ not json' });
    app = await buildTestApp(upstream.url);

    const first = await app.inject({ method: 'GET', url: '/broken' });
    expect(first.statusCode).toBe(502);
    const second = await app.inject({ method: 'GET', url: '/broken' });
    expect(second.statusCode).toBe(502);
    expect(upstream.requestCount('/broken')).toBe(2); // errors are not cached
  });

  it('returns 504 on upstream timeout', async () => {
    upstream.route('/slow', { body: '{}', delayMs: 2_000 });
    app = await buildTestApp(upstream.url, { UPSTREAM_TIMEOUT_MS: '200' });

    const res = await app.inject({ method: 'GET', url: '/slow' });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toContain('upstream');
  });

  it('serves repeat requests from the metadata cache', async () => {
    servePackument('cached', makePackument('cached', { '1.0.0': daysAgo(30) }));
    app = await buildTestApp(upstream.url);

    expect((await app.inject({ method: 'GET', url: '/cached' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/cached' })).statusCode).toBe(200);
    expect(upstream.requestCount('/cached')).toBe(1);
  });

  it('propagates upstream 404 as npm-style not found', async () => {
    app = await buildTestApp(upstream.url);
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found' });
  });

  it('supports ETag revalidation on the filtered document', async () => {
    servePackument('etagged', makePackument('etagged', { '1.0.0': daysAgo(30) }));
    app = await buildTestApp(upstream.url);

    const first = await app.inject({ method: 'GET', url: '/etagged' });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);

    const second = await app.inject({ method: 'GET', url: '/etagged', headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
  });

  it('answers HEAD without a body', async () => {
    servePackument('headpkg', makePackument('headpkg', { '1.0.0': daysAgo(30) }));
    app = await buildTestApp(upstream.url);

    const res = await app.inject({ method: 'HEAD', url: '/headpkg' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

describe('read-only enforcement and passthrough', () => {
  it('rejects publish/mutation methods', async () => {
    app = await buildTestApp(upstream.url);
    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/foo' });
      expect(res.statusCode, method).toBe(405);
    }
    expect((await app.inject({ method: 'POST', url: '/foo' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'PUT', url: '/-/user/org.couchdb.user:x' })).statusCode).toBe(405);
  });

  it('passes npm 6 audit POSTs through to the upstream', async () => {
    upstream.route('POST /-/npm/v1/security/audits/quick', { body: '{"actions":[]}' });
    app = await buildTestApp(upstream.url);

    const res = await app.inject({
      method: 'POST',
      url: '/-/npm/v1/security/audits/quick',
      payload: '{"name":"x"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actions: [] });
  });

  it('proxies /-/ping but blocks other meta endpoints that would leak version data', async () => {
    upstream.route('/-/ping', { body: '{}' });
    upstream.route('/-/v1/search', { body: '{"objects":[]}' });
    app = await buildTestApp(upstream.url);

    expect((await app.inject({ method: 'GET', url: '/-/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/-/v1/search?text=foo' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/-/package/foo/dist-tags' })).statusCode).toBe(404);
  });

  it('does not forward client Authorization headers upstream', async () => {
    servePackument('authtest', makePackument('authtest', { '1.0.0': daysAgo(30) }));
    app = await buildTestApp(upstream.url);

    await app.inject({ method: 'GET', url: '/authtest', headers: { authorization: 'Bearer npm_SECRET' } });
    const seen = upstream.requests.find((r) => r.url.startsWith('/authtest'));
    expect(seen).toBeDefined();
    expect(seen!.headers.authorization).toBeUndefined();
  });
});

describe('service endpoints', () => {
  it('GET /health returns 200', async () => {
    app = await buildTestApp(upstream.url);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('GET /metrics exposes Prometheus counters', async () => {
    servePackument('metricpkg', makePackument('metricpkg', { '1.0.0': daysAgo(30), '2.0.0': daysAgo(1) }));
    app = await buildTestApp(upstream.url);

    await app.inject({ method: 'GET', url: '/metricpkg' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('npm_proxy_metadata_requests_total 1');
    expect(res.body).toContain('npm_proxy_versions_blocked_total 1');
    expect(res.body).toContain('npm_proxy_metadata_cache_misses_total 1');
  });
});
