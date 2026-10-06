# Phase 0: Complete measurements and confirm worker wake

Status: Histogram export implemented; existing wake tests pass. Requests: F5/F6.
Production baseline/waterfall measurement outstanding; see measurement-runbook.md.

## Implementation

Extend `service/src/access-log.ts` using fixed-memory histograms independent of
log severity. Do not infer percentiles from ordinary completion logs: successful
fast `/agent/state` requests are debug-only. First inspect the existing collector;
reuse equivalent complete measurements if already available.

Default export if there is no collector: emit structured interval bucket counts
at info every 60 seconds, with interval start/end, process identifier, count,
sum and non-overlapping duration buckets. Use boundaries in milliseconds:
5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, infinity.
Label method, registered route template and status class only. Bound unmatched
traffic to one route label. Reset intervals after export; final shutdown flush
is best effort. No per-request accumulation or synchronous logging on hot paths.

Aggregate matching buckets before deriving approximate p50/p95; show counts and
overflow explicitly. Provide a small documented log query or developer script
for a chosen time window. If the collector supports native histograms, use that
export instead; do not maintain two metric systems. Select export in this phase
and record the decision and operational availability.

Separate ordinary HTTP completion duration from SSE headers/first-frame timing
and stream lifetime. First frame may be a heartbeat; do not label it model TTFT.
Record response-byte totals separately where known. Do not count missing byte
measurements as zero.

Verify existing `subscribeInvocationChanges` → `worker.wake()` wiring, including
raw-pg browser continuation commits. Keep one-second recovery/maintenance and
DB claim authority. Add no replacement scheduler. Record service/worker topology
and run existing worker/timing/event tests, distinguishing skipped DB tests.

## Baseline / acceptance

- [ ] Short/long thread open, warm/cold budget, history page, send/admission and
      ten-minute visible idle-thread workload defined with payload sizes/counts.
- [ ] Fast state requests counted even when completion logs are suppressed.
- [ ] Metrics contain no identities, URLs, payloads or credentials; bounded memory.
- [ ] Tests cover buckets, interval reset, aggregation and SSE separation.
- [ ] Before/after route count, error rate, p50/p95 and client request waterfalls
      recorded using comparable workloads and sample counts.
- [ ] Worker confirmation handed to mobile; no claim of fixed one-second saving.

No production SLO is invented here. Set numeric latency budgets from the baseline;
correctness fixes must not wait for production telemetry access.
