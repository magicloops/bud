# Phase 7: R2 release delivery

Status: Phases 7a/7b and the Node action fix are merged (PRs #143/#144).
Worker implementation is validated locally; deployment/edge acceptance remains
pending. Phase 7c implementation is locally validated; authorized deployment and live
acceptance remain pending.

Pre-launch rollout decision: no users depend on this host yet. Validate directly
on get.bud.dev after an authorized promotion; omit the candidate Worker and
second hostname. Retain integrity checks and rollback. Initially retain only
v0.1.25 (current) and v0.1.24 (rollback/development); older releases remain
canonical on GitHub and can be mirrored explicitly when needed.
Manual provisioning: [Phase 7a setup runbook](phase-7a-cloudflare-setup.md).

## Context

The v0.1.25 Apple Silicon archive (16.3 MB) took about one minute in both a browser and `bud upgrade`. Curl reproduced roughly 265 KB/s through the first-party URL and directly through GitHub. The Worker redirect completed in 90 ms; a Cloudflare 1 MiB comparison completed in 0.4 seconds. An isolated full download remained slow, although later small ranges were faster. The exact CDN/network cause remains uncertain.

- [Measurements and reproduction](../../debug/release-download-throughput.md)
- [Current publication/promotion](phase-4-ci-publish-and-promotion.md)
- [Hosting spec](../../deploy/get-bud-dev/get-bud-dev.spec.md)
- [Release tooling spec](../../scripts/scripts.spec.md)
- [Workflow spec](../../.github/workflows/workflows.spec.md)
- [Earlier R2 hosting recommendation](../../design/release-artifact-hosting-r2-vs-s3.md)

Current delivery is `get.bud.dev -> github.com -> release-assets.githubusercontent.com`. The Worker caches only its redirect. Promotion also replaces the generated release map with one version, which explains why previously promoted first-party archives can disappear.

## Objective and acceptance

Serve verified release bytes from Cloudflare without sending installers to GitHub, retaining existing archive URLs and manifest schema.

- Full downloads of all four platform archives match published SHA-256 and byte size.
- Promotion cannot select a version until every required archive is mirrored and verified.
- A later promotion or rollback preserves previously mirrored versioned URLs and manifests.
- A missing/corrupt upload cannot publish a new stable manifest; retries are safe and cannot replace immutable content.
- `GET`, `HEAD`, single byte ranges and conditional requests have consistent cold/warm behavior.
- Benchmark complete downloads, not just redirect/HEAD or small ranges. Target a median below 10 seconds for the current Apple Silicon archive on the affected connection, at least 3x faster than the recorded baseline. Record three serial full transfers plus a second network; distinguish cold R2 reads from warm edge hits. If the target is missed, investigate before declaring the performance issue resolved.

## Design / approach

Use one private R2 bucket, `bud-releases-prod` per the earlier hosting design, bound to the existing Worker as `RELEASES`. Confirm whether it already exists before provisioning. Keep the public hostname and versioned paths. Stream R2 bodies through the Worker and use `caches.default` for immutable full responses. This avoids a second public hostname and keeps routing in one place. Cache API storage is local to each Cloudflare data center and does not provide tiered caching; a miss reads R2 directly. See [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) and [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

GitHub remains the canonical release archive. Tag builds/publication stay as they are. Extend the existing manually dispatched promotion workflow to mirror the selected GitHub release before deploying its stable manifest. One upload implementation also supports explicit backfill without changing stable.

Object keys match public paths without the leading slash:

```text
releases/v0.1.25/bud-aarch64-apple-darwin.tar.gz
releases/v0.1.25/bud-x86_64-apple-darwin.tar.gz
releases/v0.1.25/bud-aarch64-unknown-linux-gnu.tar.gz
releases/v0.1.25/bud-x86_64-unknown-linux-gnu.tar.gz
releases/v0.1.25/manifest.json
```

Upload the version manifest last, after verifying all archives; it marks a complete mirrored release. Continue serving the mutable stable manifest and installer from deployed static assets with `no-store`. Serve historical version manifests from R2, independent of which version is stable. Retain mirrored releases without automatic expiry in this phase.

### Ownership and permissions

Artifacts are intentionally public Bud release resources, not user/thread resources. Only the repository's authenticated release operators can invoke promotion; bucket-scoped CI credentials authorize object reads/writes. The public Worker accepts only read requests on validated release paths, exposes no bucket listing or upload endpoint, and uses its R2 binding only for reads. No service ownership queries, user rows or database changes are needed.

## Phase 7a: verified mirror tooling and infrastructure

- [x] Manual private bucket/token setup reported complete; required GitHub secret names verified. Bucket access and all five uploaded objects verified in run 38035057306.
- [x] Add mirror tooling using a maintained S3-compatible client with bucket-scoped CI credentials. Keep credentials in GitHub secrets, never generated assets or logs.
- [x] Fetch the exact GitHub release manifest and archives using `GH_TOKEN`; do not follow arbitrary manifest-provided URLs to acquire files. Derive filenames from the known target matrix and validated version.
- [x] Require each current supported target exactly once; reject duplicates, malformed versions/paths, missing assets, size or checksum mismatch before upload.
- [x] Store archive HTTP metadata and SHA-256 metadata. Re-read uploaded bytes and verify SHA-256/size before writing the version manifest.
- [x] Existing matching objects make a rerun idempotent; existing differing bytes fail rather than overwrite. Verify existing bytes, not just a caller-supplied metadata checksum. Serialize mirror/promotion runs using a shared non-canceling workflow concurrency group and conditional creation where the chosen API supports it.
- [x] Support explicit versions for backfill using the same verification path. Partial uploads remain harmless and resumable; they never advance stable.

Validation: `npm test --prefix scripts` passes 18 tests, including actual SDK
HTTP transport against a local S3 fixture. The user completed manual bucket/token
provisioning; [run 38035057306](https://github.com/magicloops/bud/actions/runs/38035057306)
verified all four v0.1.25 archives and the manifest on 2026-10-10.
[Run 38035311447](https://github.com/magicloops/bud/actions/runs/38035311447)
verified all five existing objects without uploads; public stable remains v0.1.25.

Exit: local fixture tests exercise all failure paths; an explicitly selected real release can be mirrored and verified without changing the deployed stable version.

## Phase 7b: Worker byte delivery and caching

- [x] Configure and confirm the `RELEASES` binding to the private bucket in the dashboard and checked-in Worker config.

- [x] Replace Worker archive redirects and `_release-assets.json` reads with R2 delivery; stable/installer remain static. Phase 7c removes obsolete generation/tests.
- [x] Serve only known archive names and published version manifests. A missing object returns uncached 404; R2 failures return an uncached 503 rather than redirecting silently to GitHub.
- [x] Stream full bodies without buffering the archive in Worker memory. Return accurate `Content-Length`, content type, `Content-Disposition`, ETag, `Accept-Ranges` and immutable cache headers.
- [x] Cache successful complete `200` responses with canonical pathname keys; discard irrelevant query strings. Do not cache errors, partial responses or a HEAD body as the full archive. Cache-write failure must not fail the download.
- [x] Implement single closed/open/suffix ranges on cold R2 reads and warm cache hits, including `206`, correct lengths/`Content-Range`, unsatisfiable `416`, and explicit multi-range behavior (ignore unsupported multi-range and return the full representation).
- [x] Implement `If-None-Match` and `If-Range` consistently. HEAD returns full-representation metadata and no body; it must not download the full object just to populate cache.
- [x] Add an explicit diagnostic header for edge HIT/MISS/BYPASS and structured origin/error logging without credentials. Cloudflare's cache match can serve ranges from a complete cached response with `Content-Length`; test the actual deployed behavior.

Local evidence: 24 fixture/workerd tests pass, including actual R2 and Cache
API range reads with a 2 MiB archive. Node action v6 fix is merged; promotion runs the new Worker suite before deployment.
[Direct deployment and edge validation](phase-7b-validation.md) remains pending.

Exit: Worker tests and a deployed get.bud.dev route prove byte integrity, cold/warm semantics and bounded streaming behavior.

## Phase 7c: promotion, backfill and rollout

- [x] Promotion downloads/verifies/mirrors all four GitHub assets, then generates stable assets and deploys the R2-enabled Worker. Fail before deployment if the mirror is incomplete.
- [x] Add full-download SHA-256/size checks for all four first-party archives to deployed smoke tests; preserve installer and stable-manifest checks. Check ranges and one warm cache request too.
- [x] Inventory and retain v0.1.25 and v0.1.24 using the mirror-only workflow. Older versions stay on GitHub unless needed for development/rollback; do not invent missing manifests or automatically mirror canaries. Record coverage and omissions.
- [ ] Validate historical URLs after a subsequent promotion and rollback. Rollback repoints only stable; R2 versioned bytes and manifests stay immutable.
- [ ] Purge old archive redirect entries from Cloudflare during cutover. Existing browser-cached year-long 302s cannot be purged remotely; validate with fresh clients and make the next newly tagged release the clean browser-cache path. Existing curl/reqwest callers do not need a client upgrade.
- [ ] Benchmark the actual full archive from the affected machine and a second network, recording cache status and repeat variability.
- [ ] Exercise normal installer and `bud upgrade` from v0.1.24/v0.1.25 in isolated state, ensuring checksum validation and service refresh still work.

Exit: production smoke checks and performance evidence pass; prior URLs and rollback remain usable.

## Test plan

- Mirror fixtures: complete target matrix, duplicates/missing targets, malformed paths, wrong hashes/sizes, interrupted upload, read-back corruption, matching rerun, conflicting existing object and failure before stable deployment.
- Worker: GET/HEAD, full stream, cold/warm cache, cache-write failure, query normalization, ETag/304, If-Range match/mismatch, all single-range forms, 416, multi-range full response, 404/503 no-store, method rejection and no outbound GitHub fetch.
- Workflow: failed upload prevents deployment; successful upload precedes version-manifest publication and stable change; previous mirrored release remains downloadable after new promotion.
- Deployed: full checksums on all targets, historical URL, rollback, installer/upgrade and three serial full-transfer timings from each validation network.

## Risks and limits

- R2/Worker access becomes the serving dependency. Cache misses and cache eviction must work from R2; no GitHub fallback path is added in this scope.
- Bytes are immutable by policy and tooling, not by an unrestricted bucket writer. Restrict credentials and forbid destructive/overwrite operations in the release workflow.
- Streaming/cache integration can accidentally buffer, cache partial content or delay first byte; test a real archive in addition to fixtures.
- Rollback of Worker code restores the old hosting path if necessary. Rolling back stable to a prior version is a separate operation and must use the new verified mirror workflow.
- Public requests remain anonymous; require only tightly scoped release routes and existing Cloudflare protection. Broader analytics, automatic release promotion, client progress UI and adaptive parallel downloads are deferred.

## Spec files and docs to update during implementation

- [ ] `deploy/get-bud-dev/get-bud-dev.spec.md`
- [ ] `deploy/get-bud-dev/release-hosting.md`
- [ ] `scripts/scripts.spec.md` (new mirror helper/tests and removal of redirect-map tooling)
- [ ] `.github/workflows/workflows.spec.md`
- [ ] Install-script parent implementation/progress/validation docs and original Phase 4 references, identifying this phase as the replacement for archive redirects
- [ ] Debug note with deployed timings and completion evidence

## Impacted contracts / rollout

Hosting and release automation only. Manifest schema, archive URLs, checksums and binary contents remain unchanged. WSS, SSE, database, agent tools and web/mobile application code are unaffected.

Deploy order: provision credentials/bucket -> mirror and verify retained versions -> deploy Worker/promotion changes -> run production smoke/performance checks -> publish/promote the next normal release. No daemon restart or new daemon tag is needed to improve downloads from uncached existing URLs.

## Phase 7c implementation scope and next steps

- One promotion helper downloads exact GitHub assets once, verifies/mirrors them
  and generates stable assets only after R2 read-back succeeds. Failures cannot
  reach deployment. Remove obsolete redirect-map and static historical generation.
- Mandatory deployed smoke checks stream/hash all four archives, verify stable
  and historical manifests, HEAD, ranges, ETag and one warm full cache hit.
  Poll read-only requests for edge propagation; never retry a deployment automatically.
- Reuse mirror-only workflow for the selected rollback version. No new uploader,
  legacy routing or broad historical backfill is needed.
- After implementation review/merge, manually confirm the binding and authorize
  promotion of v0.1.25. Purge redirects through the dashboard if needed; verify
  retained URLs and record three serial full transfers on each of two networks.
- Finally exercise install/upgrade in isolated state and a stable rollback/re-promotion.
  These operations need separate deployment/release authorization. No new tag needed.

Specs affected: scripts/scripts.spec.md, .github/workflows/workflows.spec.md,
deploy/get-bud-dev/get-bud-dev.spec.md and install-script.spec.md. No application
protocol, database or client changes.

Local Phase 7c evidence: 24 release/mirror/promotion/smoke tests pass. Inventory
confirmed v0.1.24 has all four target archives and manifest; actual mirroring,
direct deployment, redirect purge, two-network benchmarks and rollback are pending.
