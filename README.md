# npm-age-proxy

A small, auditable, **read-only** npm registry proxy that hides package versions
younger than a configurable minimum age (default: **7 days**). It exists for
legacy npm clients (npm 5/6) that cannot use modern npm's `min-release-age`
setting, as a mitigation against supply-chain attacks via freshly published
packages.

Point npm at the proxy:

```ini
registry=https://npm-proxy.example.com/
```

and versions published less than `MIN_PACKAGE_AGE_DAYS` ago simply do not
exist: they are removed from package metadata, dist-tags never point at them,
and their tarballs return **403**.

## How it works — and why metadata filtering alone is not enough

For a metadata request (`GET /express`, `GET /@scope%2fpkg`) the proxy fetches
the **full** packument from the upstream registry (the abbreviated
"install-v1" format has no publication timestamps, so the full document is
always used), then:

1. removes every version whose publication timestamp is younger than the
   minimum age — or whose timestamp cannot be reliably determined (**fail
   closed**);
2. rewrites `dist-tags` with proper semver ordering so no tag points at a
   removed version (`latest` is repointed to the newest allowed stable
   version; other tags pointing at blocked versions are dropped);
3. rewrites every remaining version's `dist.tarball` URL to
   `PUBLIC_REGISTRY_URL`, so lockfiles generated through the proxy keep
   resolving through the proxy;
4. filters the served `time` map so blocked versions don't leak.

**Metadata filtering alone is bypassable.** `package-lock.json` stores fully
resolved tarball URLs, and npm 5/6 fetch those URLs directly without ever
consulting metadata (`npm ci` in particular). So the proxy *also* enforces the
policy on every tarball download: `GET /foo/-/foo-1.2.3.tgz` re-checks the
publication timestamp of `foo@1.2.3` and returns 403 if it is too young:

```json
{ "error": "foo@1.2.3 is only 2.4 days old. Minimum package age is 7 days (168h)." }
```

Allowed tarballs are streamed from the upstream (never buffered in RAM) and
optionally cached on disk.

## Installation

Requires Node.js >= 20.

```bash
npm ci
npm run build
PUBLIC_REGISTRY_URL=https://npm-proxy.example.com npm start
```

Development: `npm run dev` · Tests: `npm test` · Type check: `npm run typecheck`

## Docker

```bash
cp .env.example .env   # edit PUBLIC_REGISTRY_URL at minimum
docker compose up -d --build
```

The image is a multi-stage build, runs as the non-root `node` user, exposes
port 3000, and mounts a named volume at `/cache` for the tarball disk cache.

## Configuration

All configuration is via environment variables, validated at startup:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `UPSTREAM_REGISTRY` | `https://registry.npmjs.org` | The only upstream the proxy will ever talk to |
| `PUBLIC_REGISTRY_URL` | `http://localhost:$PORT` | Public base URL of this proxy; baked into rewritten tarball URLs (and thus lockfiles) — set it to the real external URL |
| `MIN_PACKAGE_AGE_DAYS` | `7` | Minimum version age in days |
| `MIN_PACKAGE_AGE_HOURS` | — | Minimum version age in hours. **If both are set, HOURS wins.** |
| `METADATA_CACHE_TTL_SECONDS` | `300` | In-memory cache TTL for raw upstream packuments |
| `NEGATIVE_CACHE_TTL_SECONDS` | `60` | Cache TTL for upstream 404s (5xx/timeouts are never cached) |
| `LOG_LEVEL` | `info` | pino log level |
| `MIN_AGE_EXCLUDE_PACKAGES` | — | Comma-separated package names that bypass the age policy |
| `MIN_AGE_EXCLUDE_VERSIONS` | — | Comma-separated exact `name@version` pairs that bypass it (e.g. `foo@1.2.3,@scope/bar@4.5.6`) |
| `TARBALL_CACHE_DIR` | disabled | Directory for caching allowed tarballs on disk |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Upstream connect/header timeout |
| `MAX_METADATA_BYTES` | `64 MiB` | Max decompressed upstream packument size (full packuments for big packages are tens of MB — don't set this low) |
| `METADATA_CACHE_MAX_BYTES` | `256 MiB` | Byte cap for the in-memory packument cache (LRU eviction) |

Notes:

- The raw upstream packument is cached and the policy is applied per request,
  so versions become visible the moment they age past the threshold — no
  cache-expiry lag, and exclusion-list changes apply on restart immediately.
- The in-memory cache sits behind a small async `CacheStore` interface
  (`src/cache.ts`), so a shared store like Redis can be slotted in later
  without touching the rest of the code.

## Pointing legacy npm at the proxy

```bash
npm config set registry https://npm-proxy.example.com/
```

or in `.npmrc` (per-project or per-user):

```ini
registry=https://npm-proxy.example.com/
```

Verify:

```bash
npm config get registry        # should print the proxy URL
npm install --verbose          # watch the http fetch lines hit the proxy
curl https://npm-proxy.example.com/health
curl https://npm-proxy.example.com/metrics
```

A quick way to see the policy in action: request a package that released
recently and compare `dist-tags.latest` with the upstream's.

## Endpoints

| Endpoint | Behaviour |
|---|---|
| `GET/HEAD /{pkg}`, `/{@scope/pkg}` (also `%2f`-encoded) | Filtered packument |
| `GET/HEAD /{pkg}/-/{file}.tgz` | Age-checked tarball (403 if too young) |
| `GET /health` | 200 when the service is up |
| `GET /metrics` | Prometheus counters (requests, cache hits/misses, blocked versions/tarballs, upstream errors) |
| `GET /-/ping`, npm audit `POST`s | Proxied to upstream |
| everything else | 404 — endpoints like `/-/v1/search` would leak unfiltered version data, so passthrough is default-closed |
| `PUT`/`DELETE`/other `POST` | 405 — the proxy is strictly read-only; publishing is not supported |

`/health` and `/metrics` shadow the (real) npm packages of the same names; if
you need to install those through the proxy, move the endpoints behind a
different path in `src/server.ts`.

## Security properties

- Upstream requests only ever go to `UPSTREAM_REGISTRY`; redirects are followed
  only within that origin (no SSRF via crafted paths or upstream redirects).
- Package names are validated (`validate-npm-package-name`, legacy names
  accepted); tarball filenames are strictly validated; decoded paths
  containing `..`, `\`, or NUL are rejected; disk-cache keys are fully
  percent-encoded so request data cannot traverse the cache directory.
- **Fail closed**: a version with a missing or unparseable publication
  timestamp is treated as blocked (metadata and tarball) unless explicitly
  excluded. Policy blocks are 403; upstream failures are 502/504 — an outage
  is never disguised as a policy decision.
- Upstream responses are untrusted: size-capped, JSON parsed defensively,
  tarballs streamed, timeouts enforced.
- Client `Authorization` headers are never forwarded upstream and are redacted
  in logs. Stack traces are not exposed when `NODE_ENV=production`.
- Graceful shutdown on SIGTERM/SIGINT (10s deadline).
- No authentication is required of clients today, but all route handlers get
  their dependencies through one `AppContext`, so an auth hook can be added in
  `src/server.ts` without restructuring.

## Limitations — read this

The proxy governs **npm-registry packages fetched through it**. It cannot
protect against:

- **git dependencies** (`"dep": "github:user/repo"` or git URLs) — fetched
  directly from git hosts, never touching the registry;
- **arbitrary HTTP(S) tarball dependencies** (`"dep": "https://…/x.tgz"`);
- **dependencies configured to use another registry** (per-scope
  `@corp:registry=…` entries in `.npmrc` pointing elsewhere);
- **lockfiles with `resolved` URLs pointing at another registry** — including
  lockfiles generated *before* the proxy was adopted, whose entries still
  point at `registry.npmjs.org` directly. Regenerate the lockfile through the
  proxy (`rm package-lock.json && npm install`) or rewrite the `resolved`
  fields;
- anything installed with `--registry` overrides, `file:` deps, or vendored
  tarballs.

Also note: the age policy uses the upstream's `time` map. If an attacker
compromises the upstream registry itself, the proxy's guarantees are limited
to what that metadata claims.

## npm compatibility

Tested against the behaviours of npm 5/6: full-JSON packuments are served for
both `application/json` and `application/vnd.npm.install-v1+json` Accept
headers (old clients consume the full document fine); `dist-tags.latest`
always exists when any version is allowed; npm 6's automatic audit POSTs are
proxied so installs stay quiet; ETag revalidation is supported on the
filtered metadata (`If-None-Match` → 304) with short `Cache-Control` so
clients notice versions aging in.
