# Validation Checklist: Automatic Context Compaction

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Automated Validation

- [ ] Checkpoint repository returns latest completed checkpoint only.
- [ ] Failed and canceled checkpoints are ignored by loader reconstruction.
- [ ] Checkpoint writes inherit `created_by_user_id` and `tenant_id` from the thread.
- [ ] Replacement history round trips through JSONB.
- [ ] No-checkpoint loader output matches the previous baseline.
- [ ] Checkpointed loader output begins with fresh system prompt, then replacement history, then post-checkpoint delta.
- [ ] Provider-ledger rows before the checkpoint boundary are excluded.
- [ ] Provider-ledger rows after the checkpoint boundary are included for same-provider replay.
- [ ] Provider-switch fallback after checkpoint uses canonical post-checkpoint rows.
- [ ] Compaction provider invocation uses no tools.
- [ ] Replacement history excludes the base system prompt and old context-sync rows.
- [ ] Recent user-message budget and truncation marker work.
- [ ] Mid-turn terminal context note is included when supplied.
- [ ] Provider context-window errors normalize to a typed retryable error.
- [ ] Non-context provider errors are not retried as compaction.
- [ ] Trimming retry preserves tool-use/tool-result pairing.
- [ ] Pre-turn trigger compacts before provider invocation over threshold.
- [ ] Mid-turn trigger compacts before follow-up provider invocation over threshold.
- [ ] Disabled auto-compaction kill switch prevents automatic triggers.
- [ ] Model preference PATCH performs no provider call.
- [ ] `/api/threads/:thread_id/messages` output is unchanged by automatic compaction.

## Manual Service Validation

- [ ] Start a short normal thread and confirm no checkpoint row is created.
- [ ] Create a long synthetic thread and confirm the next agent turn creates one completed checkpoint.
- [ ] Confirm the visible chat transcript does not show a compaction summary row.
- [ ] Restart the service and confirm the next turn uses the latest completed checkpoint.
- [ ] Force a large tool result and confirm mid-turn compaction continues the loop.
- [ ] Switch to a smaller model and confirm compaction happens on the next message send when needed.
- [ ] Set `AGENT_AUTO_COMPACTION_ENABLED=false` and confirm automatic checkpoint creation stops.
- [ ] Confirm failed compaction surfaces a clear agent/runtime error.
- [ ] Confirm logs include checkpoint id, phase, reason, and token counts without raw summary text.

## Stream And Client Validation

Complete this section only if Phase 5 ships stream events.

- [ ] `agent.compaction_start` arrives before the compaction provider call.
- [ ] `agent.compaction_done` arrives after completed checkpoint persistence.
- [ ] `agent.compaction_failed` arrives after failed checkpoint persistence.
- [ ] Existing web stream reducer tolerates the event family.
- [ ] Event payloads contain no raw summary text.
- [ ] `docs/proto.md` documents the event names and payload fields.

## Manual Route Validation

Complete this section only if Phase 5 ships manual compaction.

- [ ] Owner can call `POST /api/threads/:thread_id/agent/compact`.
- [ ] Unauthenticated request receives `401`.
- [ ] Authenticated non-owner receives `404`.
- [ ] Route response excludes raw `replacement_history`.
- [ ] Active-run conflict behavior matches the implementation spec.
- [ ] Manual compaction emits the same event family if stream events are enabled.

## Migration And Rollout Validation

- [ ] `pnpm db:push` applies the local schema change.
- [ ] `pnpm db:generate` creates a checked-in migration.
- [ ] Generated SQL includes all checkpoint columns and indexes.
- [ ] Migration metadata is reviewed.
- [ ] `service/drizzle/migrations/migrations.spec.md` is updated.
- [ ] Staging `pnpm db:migrate` applies the migration.
- [ ] Rollback instructions mention the automatic trigger kill switch.
- [ ] Emergency loader-bypass decision is documented if needed.
