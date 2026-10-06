# Phase 4: Optional bounded budget reuse

Status: Deferred. Request: F2 refinement. No representative post-Phase-2 evidence
yet justifies the cache and its invalidation complexity. Revisit after measurements;
do not interpret this as proof that idle reconstruction is cheap.

## Entry decision

After Phase 2, measure repeated idle budget reconstruction and meter-only reads.
Proceed only if they remain material in representative open/reopen workloads.
Otherwise record “deferred” with evidence; this is not a blocker for Phases 1–3.
No durable budget projection or database migration in this phase.

## Design if selected

Add one bounded process-local cache shared by open/state/budget reads. Start with
at most 256 owner/thread entries, LRU eviction, five-minute maximum age; these
are tunable implementation limits, not API guarantees. Store only the compact
snapshot and internal validity identity. Never retain conversation content.

Use an owner/thread generation plus effective model/reasoning, environment/tool
identity and accounting-policy identity. Document all invalidators: message
create/update/delete/restart repair, provider usage-anchor changes, checkpoints,
model preferences/default/catalog, environment/tool availability and permission
changes. If an input lacks reliable invalidation, omit cached data on that path;
TTL alone must not make stale values appear current.

Cache dedicated reconstruction results and applicable agent-produced snapshots.
Reconstruction captures generation before reads and checks it before insertion;
discard superseded results. One in-flight reconstruction per key/generation.
Ending a turn must not make its pre-final decision a fresh idle estimate: mark it
stale or evict until post-final inputs are reconstructed. Owner changes/deletion
evict. Restart is a normal cold miss.

Open/state only peek; they never reconstruct on cache miss. Budget reads can
reconstruct. Preserve actual `checked_at`, `source`, `stale`, model and turn;
serving a cached value must not refresh its measurement timestamp. Stale values
are display-only and never control agent compaction/admission.

## Acceptance

- [ ] Warm applicable idle reopen avoids a budget read without delaying open.
- [ ] Cold open still paints before optional reconstruction.
- [ ] Every invalidator, late calculation, thread/owner switch, eviction and
      process restart tested; compact bounded memory demonstrated.
- [ ] Before/after request counts, reconstruction cost and cache hit rate justify
      retention; no hidden repeated background reconstruction loop.

If reliable invalidation costs more than the measured gain, defer this phase
instead of shipping a weak freshness promise.
