# Phase 2: Provider Usage Plus Delta

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Add Tier 1 context estimation using the latest valid provider usage anchor plus an estimated delta.

By the end of this phase:

- snapshots can use `basis: "provider_usage_plus_delta"`
- provider output tokens are included when they may become replayed assistant context
- stale anchors are rejected
- Tier 1 falls back to Tier 0 without user-visible failure

## Scope

### In Scope

- latest valid `llm_call.usage` lookup
- checkpoint-boundary filtering for usage anchors
- provider/model/reasoning match checks
- output-token handling
- post-call delta estimation
- Tier 1 tests

### Out Of Scope

- provider token-count API calls
- tokenizer adapters
- persisted budget snapshot cache
- analytics

## Implementation Tasks

### Task 1: Locate latest valid usage anchor

Find the newest successful `llm_call` for the thread that:

- is after the latest checkpoint LLM-call boundary
- matches the effective provider/model used by the current thread selection
- has usable `usage.input_tokens`
- has usable `usage.output_tokens` or can safely omit output anchoring with lower confidence

If reasoning effort is recorded on calls, include it in the match. If not, treat reasoning mismatch as an anchor invalidation until metadata is available.

### Task 2: Include output tokens

Use provider-reported output usage to represent assistant output that may be replayed into the next request.

Preferred:

```text
replayable_output_tokens = adapter-provided replayable output token count
```

First-pass fallback:

```text
replayable_output_tokens = usage.output_tokens
confidence = "medium"
```

Use lower confidence when output tokens may include hidden reasoning or other non-replayable output.

### Task 3: Estimate delta after latest call

Estimate additions after the anchor:

- user messages created after the latest call boundary
- tool results persisted after the latest call boundary
- assistant/tool rows not represented by the latest call
- any current durable context-sync/system rows after the latest call

Use Tier 0 char estimates for the delta.

### Task 4: Invalidate on request-shape changes

Tier 1 should fall back to Tier 0 when:

- provider changed
- model changed
- reasoning effort changed or cannot be verified
- latest call is before the latest completed checkpoint boundary
- tool schema or system prompt fingerprint changes, if fingerprints exist
- usage data is missing or malformed

Because system prompt and tool schemas are currently static, first pass can use a simple static version constant or omit fingerprinting with a documented TODO.

### Task 5: Compare against Tier 0 in tests

Add tests that:

- prove output tokens are included
- prove anchors before checkpoint are ignored
- prove provider/model mismatch falls back
- prove missing output tokens still returns a snapshot
- prove deltas after latest call are added

## Files Likely Changed

- `service/src/agent/context-budget-estimator.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/provider.ts`
- `service/src/llm/llm.spec.md`
- `service/src/agent/agent.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Output tokens overcount hidden reasoning | Medium | Medium | Mark confidence medium and prefer adapter-specific replayable counts later |
| Latest call boundary is hard to compare with messages | Medium | Medium | Use existing checkpoint/provider-ledger ordering helpers where possible |
| Tier 1 creates false precision | Medium | Medium | Expose basis/confidence and keep rounded UI values |

## Exit Criteria

- Tier 1 snapshots are selected when a valid usage anchor exists.
- Invalid anchors fall back to Tier 0.
- Tests cover output-token inclusion and invalidation.
