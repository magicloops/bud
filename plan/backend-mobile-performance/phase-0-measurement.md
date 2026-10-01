# Phase 0: Measurement and Baseline

**Status:** Instrumentation implemented and locally tested; production/device baseline remains unmeasured.
**Parent:** [Implementation spec](implementation-spec.md).

## Outcome

Attribute latency to backend handling, queue scheduling, transport and client
decoding, and establish a repeatable comparison before optimizing.

## Implementation

1. Inspect existing request logs/monitoring before adding infrastructure. Confirm
   live service/worker count, main/auth pool sizes and persistent listener/lock
   connections. Record deployment and mobile build versions with measurements.
2. Add REST `Server-Timing: total;dur=…` before headers are sent. Define `total` as
   measured server processing through the chosen pre-send hook; it excludes
   response transfer and device decode. Expose the header to web JS if needed.
3. Add `auth`, `db` or `ser` only where real boundaries exist. Parallel query
   durations are not additive elapsed time. Avoid wrapping every DB operation or
   adding a tracing framework just to populate these fields.
4. Record route-template duration, status, row count and serialized response bytes
   with existing logging/metrics. Do not use resource IDs as metric labels or log
   transcript content, bearer tokens or tool results. Transferred/compressed bytes
   come from transport/client evidence when the server cannot observe them.
5. Measure SSE time-to-headers and time-to-first-event separately from connection
   lifetime. Distinguish heartbeat/progress from first model output.
6. Record admission-commit→claim and admission-commit→first-output, including
   waiting/retry cases separately. Avoid mixing database wall-clock timestamps
   with process monotonic timestamps without an explicit conversion strategy.

## Workloads and evidence

Measure cold/warm launch, idle and active thread open, cached revisit, new chat,
single send, concurrent sends on distinct threads, reconnect and mark read. Include
text-only, tool-heavy and long-history threads, and users with multiple Buds and
large thread inventories. Record p50/p95, sample count, request count, rows, bytes,
pool wait and errors where available. Separate local and deployed runs.

Use deterministic fixtures for comparisons and a small sample of representative
real workloads with content redacted. Agree provisional latency/byte budgets from
that baseline and write them into the validation record. Do not invent a target
percentage improvement or block correctness work on a dashboard project.

## Files and documentation

Start in `service/src/server.ts`, route modules, `auth/session.ts` and invocation
repository/worker timing boundaries. Update source/routes/agent specs only where
behavior changes. Save results with environment, command, workload and sample
count in [validation-checklist.md](validation-checklist.md).

## Acceptance and rollout

- Headers report finite, nonnegative durations on representative success/errors
  without delaying streaming or double-sending headers.
- Measurements have explicit boundaries; SSE lifetime is not a route latency.
- Baseline covers the selected workloads and documents missing production evidence.
- Instrumentation overhead is measured and acceptable against the baseline.
- Deploy instrumentation additively. Mobile can consume timings independently.

Run focused hook/route tests for timing behavior; no blanket test rewrite is needed.
