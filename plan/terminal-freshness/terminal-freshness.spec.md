# terminal-freshness

Implementation planning documents for replacing default request-time terminal context sync with cheap terminal freshness hints.

## Purpose

This folder turns [../../design/terminal-freshness-hints.md](../../design/terminal-freshness-hints.md) into an actionable phased implementation and validation plan.

The plan assumes:

- normal `POST /messages` should not call `terminal_observe` before the primary agent LLM call
- terminal freshness is internal service state, not a first-pass browser/mobile API contract
- the model should receive a transient freshness hint when current terminal state may be stale
- the hint should tell the model to call `terminal.observe` before terminal-dependent claims or actions
- offline Bud mode remains the stronger constraint and should not ask the model to call unavailable terminal tools
- `terminal.send` and `terminal.observe` tool results should advance a unified model-visible terminal watermark
- `cwd`, readiness/context, terminal output bytes, and human input should feed the same freshness decision instead of separate prompt-injection paths
- no rollback feature flag is required while the product is still in active development

## Files

### `implementation-spec.md`

Parent implementation spec for terminal freshness hints.

Documents:

- product and latency goals
- fixed design decisions
- phase sequencing
- expected code/spec areas
- risks and definition of done

### `phase-1-disable-preflight-and-freshness-hint-plumbing.md`

Initial service/agent phase covering:

- removing the normal-send preflight context-sync call
- adding internal terminal freshness types
- resolving freshness before provider calls inside the agent loop
- applying the transient model hint without persisting it
- proving no daemon roundtrip occurs in the common path

### `phase-2-terminal-visibility-watermarks.md`

Watermark phase covering:

- persisting terminal visibility metadata on terminal tool results
- advancing watermarks even for no-visible-output `terminal.send` results when terminal facts were shown
- deriving dirty state from output bytes, cached cwd, readiness/context, human input, and status changes
- keeping freshness lookups ownership-scoped through authorized thread/session rows

### `phase-3-cleanup-metrics-and-validation.md`

Finalization phase covering:

- retiring/quarantining the old preflight summary path for normal user sends
- adding observability for skipped observes, applied hints, and first-step observe behavior
- updating specs and related docs
- running automated and manual validation

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated validation checklist for terminal freshness hints.

## Dependencies

- [../../design/terminal-freshness-hints.md](../../design/terminal-freshness-hints.md) - source design and resolved product decisions
- [../../design/terminal-context-sync.md](../../design/terminal-context-sync.md) - older preflight context-sync design being superseded for normal sends
- [../../design/offline-bud-agent-turns.md](../../design/offline-bud-agent-turns.md) - offline environment behavior that must remain stronger than freshness hints
- [../../review/bud-offline-roundtrip-review.md](../../review/bud-offline-roundtrip-review.md) - roundtrip review that motivated this latency reduction
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The first implementation intentionally avoids a new database table. If deriving the latest model-visible terminal watermark from message metadata becomes expensive, add a small cache table as a follow-up.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
