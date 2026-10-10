# Phase 7b: R2 Worker validation and manual cutover handoff

Status: implemented and validated locally; candidate deployment and real edge
acceptance pending. No Cloudflare provisioning or deployment was performed.

Parent: [Phase 7](phase-7-r2-release-delivery.md).

## Local evidence

- `npm ci --ignore-scripts --prefix deploy/get-bud-dev`
- `npm test --prefix deploy/get-bud-dev`: 24 tests (route/delivery fixtures and
  actual workerd with isolated R2 and Cache API bindings).
- `npm run test:installer --prefix deploy/get-bud-dev`: 22 installer regression tests.
- `npm audit --prefix deploy/get-bud-dev`: zero reported vulnerabilities after
  scoped test-dependency patches; these dependencies do not ship in the Worker.

The runtime test streams a deterministic 2 MiB archive, checks its complete
hash, exercises R2 suffix ranges, then removes its isolated fixture origin and
proves warm ranges still return exact cached bytes. It also checks 304,
If-Range fallback, 416 and mutable stable headers. Fixture tests cover cache
failures, completion-marker gating, unsafe route rejection, interrupted origins
and slow cache writers. Cache writes use a bounded 256 KiB queue; native
FixedLengthStream preserves range-capable length metadata in workerd. Local runtime
success does not prove production cache availability or network throughput.

## Manual Cloudflare preparation

Resources are managed in the dashboard, not through the beta `cf` CLI:

1. Confirm the existing private `bud-releases-prod` bucket contains the five
   verified v0.1.25 objects from Phase 7a.
2. In Workers & Pages, configure an R2 binding **`RELEASES`** to that bucket.
   The same binding is declared in `deploy/get-bud-dev/wrangler.toml` so later
   authorized deployment preserves it.
3. For candidate acceptance, use an isolated candidate Worker with the same
   code, compatibility date and binding. Add a temporary custom hostname
   through the dashboard. Do not attach that candidate to `get.bud.dev` yet.
   Workers preview/editor URLs are insufficient to prove real edge caching;
   use a custom hostname and fresh curl clients.
4. Deploy the candidate code only when authorized. The current production
   Worker remains on GitHub redirects. A production promotion using this new
   code must select an already mirrored release until Phase 7c adds the gate.

No R2 S3 credentials are needed in the Worker; its binding grants reads. Release
artifacts are intentionally anonymous public resources, not user/thread data.
Only authenticated release operators have bucket write/promotion credentials;
the HTTP Worker permits GET/HEAD on validated paths, with no listing or writes.

## Candidate acceptance

Set `BUD_RELEASE_TEST_ORIGIN` to the candidate's HTTPS custom hostname. Example
commands below use the already mirrored release; save files in a temporary
working directory and compare against the canonical GitHub manifest:

```sh
BUD_RELEASE_TEST_DIR=$(mktemp -d)
gh release download v0.1.25 --repo magicloops/bud \
  --pattern manifest.v0.1.25.json --dir "$BUD_RELEASE_TEST_DIR"
BUD_RELEASE_TEST_URL="$BUD_RELEASE_TEST_ORIGIN/releases/v0.1.25/bud-aarch64-apple-darwin.tar.gz"
curl -fsS -D "$BUD_RELEASE_TEST_DIR/headers" \
  -o "$BUD_RELEASE_TEST_DIR/archive.tar.gz" "$BUD_RELEASE_TEST_URL"
shasum -a 256 "$BUD_RELEASE_TEST_DIR/archive.tar.gz"
curl -fsSI "$BUD_RELEASE_TEST_URL"
curl -fsS -H 'Range: bytes=0-1023' -D "$BUD_RELEASE_TEST_DIR/range-headers" \
  -o "$BUD_RELEASE_TEST_DIR/range" "$BUD_RELEASE_TEST_URL"
```

- [ ] Download all four platform archives and compare full SHA-256 and byte
  size with that manifest. Expect 200 and `X-Bud-Release-Origin: r2`, no redirect.
- [ ] Repeat a complete GET after the cache write settles; expect HIT at the
  same Cloudflare data center. Query strings should not create different keys.
- [ ] HEAD before/after warming: exact full length/ETag and no body; HEAD alone
  does not populate cache.
- [ ] Closed/open/suffix ranges: exact bytes/length/Content-Range, cold and warm.
  Warm ranges must report HIT; partial GETs never populate full-object cache.
- [ ] Matching If-None-Match returns bodyless 304; nonmatching returns 200.
  If-Range with the observed strong ETag returns 206; stale/weak tag returns 200.
- [ ] Beyond-end range returns no-store 416; malformed/multiple ranges return
  full 200. Unknown version/target returns no-store 404. POST returns 405.
- [ ] Versioned manifest bytes match the GitHub source. Installer and stable
  routes remain no-store; use the same static promotion assets for the candidate
  when checking those routes.
- [ ] Save deployed run/hostname and header/hash evidence here. Do not claim
  the original slow-download issue resolved until Phase 7c's full-transfer
  performance checks pass on the affected connection and a second network.

Real R2-failure injection is covered locally; do not revoke production access
or delete real immutable objects merely to simulate errors.

## Remaining production work

Phase 7c must integrate verified mirroring before stable promotion, remove
obsolete redirect-map generation, backfill retained versions, purge old edge
redirects, validate production downloads/rollback and measure full-transfer
speed. Browser-cached year-long redirects cannot be remotely purged; use fresh
clients and the next release's new versioned URLs for clean acceptance.
