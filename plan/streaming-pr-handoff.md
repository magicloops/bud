# Streaming PR handoff

Branch: `review/streaming-behavior`. Base matches fetched `origin/main` at preparation.
Prepared scope for the coordinated service/web and mobile PRs.

## Proposed title

Keep web agent progress visible across commentary and final-answer transitions

## Proposed description

Agent commentary could suppress progress throughout tool-argument generation,
and final completion could briefly show a spinner or regroup work late. Publish
service-owned output activity independently of unfinished drafts, and classify
completed assistant segments before persistence. Web consumes snapshot/live
activity and groups reasoning/tools around commentary, collapsing work after final.

The contract uses existing owner-authorized thread snapshots/SSE and bounded
replay. No DB migration or daemon changes. Deploy service/web together, then
update mobile; older mobile retains its previous visual behavior. New mobile
expects the updated service for activity suppression.

Temporary mobile investigation instrumentation has been removed. Missing text
and debug-build responsiveness remain open mobile follow-ups, not claimed fixes.

## Validation

- Service TypeScript check and 57 focused agent/runtime/provider tests pass.
- Web: 202 unit tests, 12 render tests, targeted ESLint and production build pass.
- The existing Vite chunk-size advisory remains; build succeeds.
- Physical-device local testing reported improved behavior; the missing-text
  symptom was not reproduced across subsequent runs.

## Scope manifest

Only the following files belong to this streaming PR. Preserve other work in the
working tree, including root TODO web-tool naming, reference handoffs, scripts,
ingestion notes and scratch files. Do not use `git add .`.

- `debug/commentary-spinner-gap.md`
- `debug/final-answer-completion-classification.md`
- `debug/streaming-experience.md`
- `design/assistant-activity-indicator-visibility.md`
- `design/assistant-output-activity.md`
- `docs/proto.md`
- `plan/streaming-experience-contract.md`
- `plan/streaming-pr-handoff.md`
- `plan/web-streaming-experience.md`
- `review/review.spec.md`
- `review/streaming-behavior-comparison.md`
- `review/web-streaming-behavior.md`
- `service/src/agent/agent-service.test.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/agent.spec.md`
- `service/src/agent/assistant-completion.test.ts`
- `service/src/agent/model-runner.test.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/output-activity.test.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/runtime.spec.md`
- `web/src/components/workbench/agent-work-group.test.tsx`
- `web/src/components/workbench/agent-work-group.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/components/workbench/thinking-indicator.tsx`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/features/threads/agent-work-projection.ts`
- `web/src/features/threads/assistant-activity-indicator-state.test.ts`
- `web/src/features/threads/assistant-activity-indicator-state.ts`
- `web/src/features/threads/threads.spec.md`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/lib/api-types.ts`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/routes.spec.md`
