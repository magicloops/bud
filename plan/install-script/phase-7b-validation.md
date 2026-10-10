# Phase 7b: R2 Worker validation and manual cutover handoff

Status: R2 Worker deployed on 2026-10-10; local live edge acceptance passes.
Checker encoding fix awaits commit/CI revalidation. Second-network performance,
isolated install/upgrade and stable rollback remain open.

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
3. Bud is pre-launch with no users relying on this host. No candidate Worker or
   temporary hostname is required. After Phase 7c is reviewed and merged,
   authorize promotion of v0.1.25 directly to get.bud.dev and run the checks below.
4. Keep the previous Worker deployment available for rollback; provision and
   purge through the dashboard, not the beta cf CLI.

No R2 S3 credentials are needed in the Worker; its binding grants reads. Release
artifacts are intentionally anonymous public resources, not user/thread data.
Only authenticated release operators have bucket write/promotion credentials;
the HTTP Worker permits GET/HEAD on validated paths, with no listing or writes.

## Direct edge acceptance

Set `BUD_RELEASE_TEST_ORIGIN=https://get.bud.dev`. Example
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
  routes remain no-store; use the deployed static promotion assets
  when checking those routes.
- [ ] Save deployed run/hostname and header/hash evidence here. Do not claim
  the original slow-download issue resolved until Phase 7c's full-transfer
  performance checks pass on the affected connection and a second network.

Real R2-failure injection is covered locally; do not revoke production access
or delete real immutable objects merely to simulate errors.

## Remaining production work

Phase 7c's verified preparation and mandatory deployed checker are implemented
and deployed. Current/historical mirroring and local edge acceptance pass;
CI checker revalidation, installer/upgrade, rollback and second-network timing
evidence remain pending. No stale redirect was observed, so no purge performed.
Browser-cached year-long redirects cannot be remotely purged; use fresh clients
and the next release's new versioned URLs for clean acceptance.

## Phase 7c operator sequence

Run mutation commands only after implementation review/merge and explicit
release/deployment authorization. Cloudflare provisioning/purging stays manual.
The workflows now accept only `version`; the old optional `smoke` input is removed
because deployed integrity checks are mandatory.

1. Confirm RELEASES binding and deployment token permissions in the dashboard.
2. Mirror v0.1.24 using the existing mirror-only workflow. v0.1.25 is already
   verified; promotion re-verifies it. Inventory on 2026-10-10 confirmed v0.1.24
   has all four target archives and manifest.v0.1.24.json. Older versions and
   install-canary tags are omitted unless needed; their GitHub assets remain.
3. Promote v0.1.25. Preparation downloads once, verifies source and R2 bytes,
   and writes stable assets only after mirror success. The same workflow then
   deploys and verifies full downloads automatically. A post-deploy smoke failure
   reports failure but does not automatically roll back; inspect and explicitly
   restore the previous Worker deployment if necessary.

```sh
gh workflow run bud-release-mirror.yml --repo magicloops/bud -f version=v0.1.24
gh workflow run get-bud-dev-promote.yml --repo magicloops/bud -f version=v0.1.25
```

Wait for the first workflow to succeed before starting promotion. Record both
run URLs. Purge existing versioned archive redirect URLs through the Cloudflare
dashboard if stale edge redirects persist, then repeat read-only checks.

4. Obtain canonical manifests and run verification on the affected connection:

```sh
BUD_RELEASE_TEST_DIR=$(mktemp -d)
gh release download v0.1.25 --repo magicloops/bud \
  --pattern manifest.v0.1.25.json --dir "$BUD_RELEASE_TEST_DIR"
gh release download v0.1.24 --repo magicloops/bud \
  --pattern manifest.v0.1.24.json --dir "$BUD_RELEASE_TEST_DIR"
node scripts/bud-release-smoke.mjs "$BUD_RELEASE_TEST_DIR/manifest.v0.1.25.json" --benchmark
node scripts/bud-release-smoke.mjs "$BUD_RELEASE_TEST_DIR/manifest.v0.1.24.json" --historical
```

The checker validates all four hashes/sizes, HEAD, ranges/416, ETag, manifests
and at least one full HIT. `--benchmark` additionally reports three serial
Apple Silicon full transfers with cache and CF-Ray evidence. Repeat on a second
network. Require the Phase 7 target (<10-second median and >=3x baseline
improvement) before marking the throughput issue resolved.

5. Exercise installer and bud upgrade on a disposable account/machine with
   isolated state, so the installed/dev daemon identities and launch agent are
   untouched. Installer fixtures already validate checksum and failure behavior;
   actual platform service refresh remains a manual check. Save version/download
   and service restart evidence.
6. With separate authorization, promote v0.1.24 as a stable rollback, validate
   it and v0.1.25 historical URLs, then promote v0.1.25 again and validate both.
   R2 versioned objects remain unchanged throughout. Record run URLs and stable
   observations rather than checking off rollback based only on local tests.

## Live rollout evidence

2026-10-10: [v0.1.24 mirror run 38038417151](https://github.com/magicloops/bud/actions/runs/38038417151)
succeeded on merged commit 5320767. All four archives were uploaded and read back
verified, then the version manifest was published and verified. All 24 release
tooling tests passed in CI. No check annotations were reported, confirming the
setup-node@v6 action warning fix on a live run. The user subsequently confirmed the RELEASES binding. Promotion was dispatched
as run 38039057997, but Worker runtime validation failed before preparation or
deployment. Production was unchanged by that first attempt.

Promotion failure follow-up: the cache readiness probe canceled a Miniflare
proxy response, raising ERR_INVALID_STATE in its Node writer cleanup. The local
fix drains and SHA-256 verifies that cached response instead. All 24 Worker
tests pass under Node 22.23.3 on macOS; the original failure was CI-only. The
fix merged in PR #146; retry run 38039166332 passed all 24 Worker tests on
Linux and deployed successfully. Its smoke step failed at manifest length
(`null !== 1225`): default Node fetch received Brotli JSON with no Content-Length.
Explicit identity encoding returned the canonical 1225 bytes and full length.
The checker now requests identity encoding; 25 release-tool tests pass locally.
This new checker fix still needs commit/CI revalidation.


## Live byte and performance acceptance, 2026-10-10

[Deployed retry run 38039166332](https://github.com/magicloops/bud/actions/runs/38039166332)
kept stable on v0.1.25. Read-only runs of the corrected checker passed for both
v0.1.25 and retained v0.1.24: all eight full archive hashes/sizes, canonical
version manifests, HEAD lengths, closed/open/suffix ranges, 304/416, and a full
warm cache hit. Current installer/root and stable are 200/no-store. Additional
live checks passed warm range HIT, weak/stale If-Range full fallback, multiple-range
full fallback, nonmatching ETag, missing-version 404 and POST 405/no-store.
No stale redirect was observed; no dashboard purge was performed.

Local SJC network timings (each transfer hashes the complete 16,294,586 bytes):

| Transfer | Seconds | Cache | CF-Ray |
|---|---:|---|---|
| First full Mac archive | 1.614 | MISS | a48461bcca60eb24-SJC |
| Warm benchmark 1 | 1.842 | HIT | a48461fd883415d8-SJC |
| Warm benchmark 2 | 1.577 | HIT | a484620919d52702-SJC |
| Warm benchmark 3 | 2.221 | HIT | a4846212ed1c15d8-SJC |

Warm median: 1.842 seconds, about 33x faster than the 61.416-second baseline.
This meets the target on this connection. Repeat the benchmark on a second
network before marking two-network acceptance complete. Historical archive
MISS transfers took 1.699–2.471 seconds and all matched canonical hashes.
