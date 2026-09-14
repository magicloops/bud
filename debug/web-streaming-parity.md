# Debug: web streaming parity

September 13, 2026. Local web at bca9c09; mobile reference 58532ac.
Plan: [web parity](../plan/web-mobile-streaming-parity.md).

## Observed from source

The live tail renders all tool bodies, then folds them at commentary boundaries.
Completion currently shares presentation eligibility with liveTurnId. The spinner
mounts after grace and animates its height; ResizeObserver and an uncancelled
nested animation frame both write bottom offsets. Latest snapshot overlay removes
synthetic rows; canonical assistant receipt removes all drafts for its turn.

## Expected and proposed fix

Stable collapsed sections, explicit final completion, shared response line,
manual disclosure inspection and cancellable follow. Preserve message identity
and loaded/live content through bounded refreshes. Keep raw scroll metrics out
of React publication. Validate source observations with regressions and browser
measurements; they are not yet measured performance claims.

## Ownership

Existing authenticated thread routes/SSE remain the data boundary. No API,
permission, database or daemon changes are intended. Local presentation/request
state resets on thread lifecycle changes; no global transcript cache.

## Implementation and validation

Service already emits `message_done.segment_kind`/`assistant_phase`; web discarded
them before message state. Forwarding them makes explicit final completion visible
before canonical persistence. Canonical upsert now preserves initial row ordering,
including equal-time ties (stable client ID instead of changing message ID).
Nonempty ended evidence is retained without inventing a final answer.

A viewport regression found an extra React render when repeated scroll samples
called the unchanged Jump state setter. A ref now guards threshold publication.
The mounted fixture verifies 100 unchanged-threshold samples without another render.
Reasoning completion also used remove-then-insert; replacing it with in-place upsert
prevents canonical timestamps from moving a reasoning row after later activity.

Commands/results:
- `pnpm --dir web test`: 209 passing.
- `pnpm --dir web test:render`: 18 passing; includes mounted React identity/hook
  tests and simulated viewport events, not real browser geometry.
- `pnpm --dir web build`: passes; existing >500 kB chunk warning remains.
- ESLint on changed TypeScript/TSX files: passes.
- `pnpm --dir web lint`: nine existing errors and one warning in unchanged files:
  unused `_draft`/`_active` in automation-proposal-summary tests; Fast Refresh exports
  in automation-proposal-summary and chat-pane-resize; unused `_response` in
  question-response-submit tests and `_stored` in workbench-view; unnamed component
  hook usage in routes/data; missing initialDraft effect dependency warning in
  routes/automations. No unrelated lint cleanup included.

During implementation `pnpm --dir web build` initially reported
`Property 'findLast' does not exist on type 'ChatMessage[]'` (current TS library
target predates ES2023). Replaced that lookup with reverse/find and rebuilt.
The first viewport test failed `5 !== 4` (render count); fixed the publication guard
rather than weakening the test. Existing conformance assertions for current-step
fields/default expanded bodies were updated to the new approved presentation.

Browser runtime returned `No browser is available`; discovery returned `[]`.
No browser fallback or timing estimates were substituted. Real layout, frame time,
focus restoration, native anchoring and live provider end-to-end acceptance remain
pending under the plan. The dev-only React test renderer emits its deprecation
warning; its structural results do not establish smooth scrolling.
