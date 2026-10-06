# HTTP measurement runbook

The selected export is structured Pino INFO logs, component `request_metrics`,
message `HTTP latency histogram`, once every 60 seconds and best-effort on close.
No metrics endpoint or second telemetry dependency is added. Ensure production
log collection retains INFO. Abrupt process death can lose the last interval.

Each record contains `instance_id`, `interval_start`, `interval_end`, `bounds_ms`,
`dropped_observations` and `routes`. Each route has method, route template, status
class, count, sum_ms, non-overlapping buckets, response_bytes and
measured_bytes_count. Bounds are 5/10/25/50/100/250/500/1000/2500/5000/10000/30000ms
and null (infinity). Never treat missing byte measurements as zero-byte responses.
A nonzero dropped count means the 2048-series bound was exceeded.

For a chosen release/time window, filter complete intervals and group by method,
route and status class. Sum counts, sums, bytes and corresponding bucket counts
across intervals/instances. The p50/p95 upper bound is the first cumulative bucket
reaching ceil(total * 0.50/0.95); null means over 30 seconds or no observations.
Never average per-instance percentiles. `request-metrics.test.ts` executes an
aggregation example and checks the distribution differs from averaged medians.
Approximate percentiles have bucket-width uncertainty; report counts and bounds.

Finite HTTP completion is measured independently of access-log severity. SSE
lifetime is excluded; headers/first-frame remain separate access-log fields.
A heartbeat can be the first frame, so this is not model time-to-first-token.

## Comparable workload

Use the same owned short and long threads and model selection before/after:
30 cold opens and 30 warm opens; 30 dedicated budget reads of each; 30 older
history pages; 30 message admissions with controlled provider behavior. Record
route counts/status classes/bytes, histogram p50/p95 and client request waterfalls.
Report cold restart separately from warm data/cache behavior. Do not send real
agent work merely to manufacture a benchmark without an appropriate test setup.

Leave a hydrated visible idle thread open for ten minutes. Expected recurring
thread state/open/budget reads: zero while transport stays healthy. Foreground,
reconnect and actual request changes are separate workloads. The automated web
test uses fake time for this count; physical browser/mobile and production latency
measurements remain outstanding. No latency improvement percentage is claimed.

For JSON-lines logs already restricted to the desired time window, this query
selects the complete measurement records (pretty terminal logs are not JSON):

```sh
jq -c 'select(.component == "request_metrics") | {instance_id, interval_start, interval_end, bounds_ms, dropped_observations, routes}' service.jsonl
```

Apply the bucket aggregation above to these records, retaining method/route/status
as the grouping key and reporting dropped observations alongside the result.
