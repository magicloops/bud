# Debug: Final answer completion classification

## Environment and observations
Production Debug mobile capture `chat-diag-3.log`: final text completion preceded
canonical final classification by 2.467 seconds. Mobile temporarily treated the
completed draft as commentary and restored the spinner before moving it back.

## Cause
The model runner emitted `agent.message_done` before the agent loop decided
whether tools follow. Clients learned segment kind only after persistence.

## Fix scope
Move draft completion emission to the agent loop after tool extraction and final
response validation, before ledger/transcript writes. Include `segment_kind`
(`intermediate` or `final`) in that same event and the runtime draft snapshot.
Keep the durable `final` event after persistence. Preserve text and client ID.

Ownership remains the existing authorized thread SSE/state boundary; no new
reads, routes, tables or owner stamping changes. No daemon changes or migrations.
Service-first rollout is additive; clients must consume the field to remove the
spinner flash. Client rendering and slight completion jitter are separate work.

Won't do: provider-specific early phase prediction, new message identities,
renderer swaps, scroll changes, timer-based guesses, or new lifecycle frameworks.

## Validation
Test final and tool-continuation classification, cancellation/invalid final
rejection before completion, replay/snapshot classification, and unchanged durable
completion boundaries. Build the service. Device validation follows client work.

Passed: `pnpm --dir service build` and 52 focused tests across
`assistant-completion.test.ts`, `model-runner.test.ts`, `agent-service.test.ts`,
`agent-runtime-state.test.ts`, and `transcript-writer.test.ts` (run with
`pnpm --dir service exec node --import tsx --test` and their `src/` paths).
The new loop fixtures use mocked provider results and persistence; no live model
or production deployment was used for validation.

## Build corrections
- `pnpm --dir service build` initially failed with TS2345: the loop retains a
  narrower model result without provider/providerModel. Narrowed the completion
  method parameter to the three fields it actually consumes.
- The next build caught TS2769 in the new test: Reflect.apply returned unknown.
  Explicitly typed the private async loop invocation as Promise<unknown>.

## Follow-ups
- Web/mobile must consume `segment_kind` atomically with completion and recover it
  from snapshots before device validation. Renderer jitter remains independent.
- Local adapters currently synthesize normal completion on some unmarked stream
  endings. Explicit provider completion-marker validation is a separate adapter
  task; this change rejects reported invalid stop reasons but does not redefine
  adapter transport semantics.
