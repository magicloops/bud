# Phase 5: Performance, UX Consistency, And Final Doc Alignment

## Objective

Finish the refactor by improving the most obvious performance-sensitive rendering paths, normalizing user-facing mutation behavior, and aligning specs/docs with the new web module layout.

## Scope

### In scope

- optimize the chat timeline and heavy renderer loading path
- normalize mutation feedback for destructive or long-running actions
- remove or gate placeholder UI that should not remain exposed
- update web specs and related docs

### Out of scope

- large new product features
- backend contract redesign
- speculative optimization unrelated to identified hotspots

## Proposed Work

### 1. Improve the timeline render path

Focus on the specific risks from the review:

- eager `ReactJsonView` loading
- eager syntax-highlighter loading
- repeated sorting and measurement work
- lack of a scalable strategy for longer transcripts

Recommended order:

1. lazy-load heavy viewers/renderers
2. simplify or isolate measurement work
3. decide whether virtualization is needed now or document it as explicit follow-up once the new boundaries are in place

Completed first slice:

- tool-payload JSON inspection now lazy-loads `@microlink/react-json-view` only when a payload is expanded
- fenced-code highlighting now lazy-loads `react-syntax-highlighter` inside `CodeBlock`
- the hot `/$budId/$threadId` route bundle dropped substantially after those changes, moving the viewer/highlighter cost behind interaction-driven async chunks

Completed second slice:

- `ChatTimeline` now consumes the chronological message list from `useThreadMessages(...)` directly instead of re-sorting a route-mapped copy on every render
- message expand/copy/payload state moved into memoized per-message rows so one row interaction does not churn list-wide UI maps
- overflow detection now happens per message row instead of rescanning every rendered transcript item after each transcript change

Remaining in this area:

- decide whether longer transcripts need virtualization now or an explicit documented follow-up

Deferred note:

- do not spend more refactor time right now trying to trim the remaining async syntax/viewer chunk by cutting language support or heavily reshaping the current renderer path
- broad language support is the preferred near-term default
- revisit this area when the current JSON inspector is replaced with a streaming JSON library, because that work is expected to change both tool-payload rendering and adjacent code-block/highlighter boundaries

### 2. Normalize mutation UX

Bring thread deletion, session closing, profile updates, and similar actions onto a consistent pattern:

- visible pending state
- visible success or optimistic update
- visible failure state
- no console-only error path for user-initiated actions

Completed slice:

- added a shared `MutationStatus` UI primitive so settings, the Bud layout banner, and the sessions modal use the same success/error/pending treatment
- thread deletion now surfaces visible success/failure at the Bud-layout level instead of only clearing rows or relying on one-off error markup
- session closing now keeps the modal body intact, shows close success/failure inline, and fixes the old double-JSON-parse fetch path
- settings mutations now use the same status treatment for username updates, provider-link redirect/error state, and sign-out failures

### 3. Remove or gate unfinished product UI

At minimum:

- wire up or hide the Bud-rail add button
- gate or hide the placeholder web-view toggle until there is a real feature behind it

Closeout decision:

- these controls are intentionally deferred to future feature PRs rather than being treated as refactor blockers
- the current web refactor should not spend additional scope on product-level decisions for the Bud-rail add flow or the future web-view mode
- keep this deferral documented clearly so the refactor can close on architecture/testing/validation work without pretending those features are complete

### 4. Final spec/documentation alignment

Update the relevant specs to describe the new layout accurately, including any new folder specs required by the extracted modules.

Expected minimum docs/spec updates:

- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/components/components.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/contexts/contexts.spec.md`
- any new folder-level spec files introduced by the refactor

## Expected File Areas

- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/ui/code-block.tsx`
- `web/src/components/message-renderers/roles/markdown-content.tsx`
- `web/src/components/workbench/thread-panel.tsx`
- `web/src/components/bud-sessions-modal.tsx`
- `web/src/components/workbench/bud-rail.tsx`
- web spec files

## Testing Strategy

### Automated

- cover lazy-load or render-path helper behavior where practical
- cover mutation feedback behavior for the standardized flows

### Manual

- long transcript browsing
- tool payload expansion
- code block rendering/copy
- thread deletion failure handling
- session close failure handling
- verify unfinished placeholder controls are not misleadingly exposed

## Exit Criteria

- heavy renderers are no longer on the hottest initial path unnecessarily
- destructive and long-running mutations use a consistent UX pattern
- unfinished placeholder UI is either gated/removed or explicitly documented as deferred future feature work outside this refactor
- web specs/docs reflect the new architecture accurately
- the full web refactor validation checklist passes
