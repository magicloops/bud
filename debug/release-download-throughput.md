# Debug: slow daemon release downloads

## Environment
- Local macOS download measurements, 2026-10-09 Pacific / 2026-10-10 UTC.
- Bud v0.1.25 Apple Silicon archive: 16,294,586 bytes.
- First-party host: Cloudflare Worker `get.bud.dev`; immutable archives reside in GitHub Releases.
- Relevant implementation: `deploy/get-bud-dev/worker.js`, `bud/src/upgrade.rs`, `.github/workflows/get-bud-dev-promote.yml`.

## Repro Steps
1. Follow the release URL with curl, downloading to `/dev/null` and recording first-byte time, total time, downloaded bytes and transfer rate.
2. Compare the same download starting directly at its GitHub Release URL.
3. Compare a 1 MiB range download, HTTP/1.1, and a Cloudflare speed-test download.

```sh
curl --max-time 90 -sS -L -o /dev/null \
  -w 'status=%{http_code} redirects=%{num_redirects} first_byte=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download} speed=%{speed_download}\n' \
  https://get.bud.dev/releases/v0.1.25/bud-aarch64-apple-darwin.tar.gz
```

## Observed

User confirmed roughly one minute in both the browser and `bud upgrade`, matching the full-archive curl reproduction.

| Measurement | First byte | Total | Bytes | Average rate |
|---|---:|---:|---:|---:|
| Worker redirect alone | 0.089 s | 0.089 s | 0 | n/a |
| Full archive through get.bud.dev | 0.345 s | 61.416 s | 16,294,586 | 265,314 B/s |
| Full archive starting at GitHub | 0.493 s | 61.119 s | 16,294,586 | 266,605 B/s |
| 1 MiB GitHub range, HTTP/1.1 | 0.251 s | 5.162 s | 1,048,576 | 203,131 B/s |
| 1 MiB range, no other debug downloads running | 2.182 s | 7.305 s | 1,048,576 | 143,541 B/s |
| Cloudflare speed-test 1 MiB | 0.152 s | 0.406 s | 1,048,576 | 2,582,794 B/s |
| Previous v0.1.24 GitHub range, isolated | 0.789 s | 1.147 s | 1,048,576 | 914,373 B/s |
| Repeated v0.1.25 first MiB, isolated | 0.469 s | 0.638 s | 1,048,576 | 1,643,329 B/s |
| v0.1.25 later MiB, isolated | 0.301 s | 1.317 s | 1,048,576 | 796,419 B/s |
| Repeated full v0.1.25 archive, isolated, timed out | 1.529 s | 45.001 s | 15,400,942 of 16,294,586 | 342,238 B/s |

- Full-archive comparisons ran concurrently, so their absolute rates can be affected by competition. The later isolated range check also reproduced low throughput.
- Actual download path: `get.bud.dev` -> `github.com` -> `release-assets.githubusercontent.com`.
- Worker returns a 302, not archive bytes. Its long-lived cache header caches the redirect, not the tarball through Cloudflare.
- Final asset headers reported `x-cache: MISS, HIT`, with cache nodes in IAD and PAO. Low throughput occurred despite a downstream cache hit; an uncached origin is not a sufficient explanation.
- HTTP/1.1 did not eliminate the slow transfer.
- Curl reproduces the issue independently of Bud's reqwest upgrade client.
- Subsequent range checks became substantially faster. Throughput is variable; the measurements do not establish a permanent GitHub bandwidth limit. Cache warming or transient CDN/network behavior remains plausible.
- A subsequent isolated full download still failed to finish within a 45-second test budget, so parallel-test competition does not account for the full-file slowness.

## Expected
- A roughly 16 MB archive should download promptly on a connection that can transfer substantially faster from Cloudflare.

## Hypotheses
- Strongest evidence: low throughput along the client-to-GitHub-release-CDN path. These measurements cannot distinguish CDN rate limiting, routing/peering, client network filtering or another destination-specific constraint.
- Worker execution/redirect latency is too small to explain the observed minute-long transfer.
- Release size contributes to duration, but does not explain the low byte rate.
- Changing Rust download timeouts or merely caching the existing 302 would not address the measured bottleneck.

## Proposed Fix / Next Steps
- Mirror verified immutable release archives to Cloudflare R2 during publication/promotion, then serve archive bytes through Cloudflare caching instead of redirecting clients to GitHub. Preserve current first-party URLs and manifest SHA-256 verification; keep GitHub as the canonical release archive.
- Scope upload permissions, publish-before-promote ordering, immutable object keys, byte/range/HEAD behavior and verification of all four platform artifacts before deployment.
- Benchmark the mirrored archive from this machine and a second network before claiming the destination-path problem resolved.
- Optional CLI download progress would improve visibility but not throughput.
- R2 custom-domain caching reference: https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/
- Specs affected by a future implementation: `deploy/get-bud-dev/get-bud-dev.spec.md`, `.github/workflows/workflows.spec.md`, and `scripts/scripts.spec.md` if release tooling changes.

## Separate Observation
- The previous version's first-party v0.1.24 archive path returned 404 after v0.1.25 promotion. Historical first-party release routing should be investigated separately; it does not explain the current archive's successful but slow download.
