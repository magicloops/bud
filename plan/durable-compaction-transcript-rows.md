# Plan: Compactions as durable transcript rows (with the summary)

Status: Implemented 2026-09-03 (service + web + backfill script). Mobile handoff: `reference/COMPACTION_TRANSCRIPT_ROWS_MOBILE_HANDOFF.md`.

Deviations: the row builder/insert lives in `service/src/agent/compaction-message.ts`
(shared by the compactor and the backfill script) rather than inside
`TranscriptWriter`; the "previews/message_count unchanged" guarantee is by
construction (the module never touches thread metadata, attention, or
notifications — nothing to mock), covered by the loader skip test and the
row-mapping tests instead of a metadata assertion.

## Context
- Related design: `design/context-compaction.md`, `design/full-transcript-mode.md` (§2.1–2.2: what is durable vs. request-time), `design/web-agent-work-collapse.md` (projection contract).
- Related spec files: `service/src/agent/agent.spec.md` (`context-compactor.ts`, `transcript-writer.ts`, `conversation-loader.ts`), `service/src/routes/threads/threads.spec.md` (`messages.ts`, `agent.ts`), `service/src/db/db.spec.md`, `service/src/scripts/scripts.spec.md`, `docs/proto.md`, `web/src/components/workbench/workbench.spec.md` (`chat-timeline.tsx`), `web/src/features/threads/threads.spec.md` (`agent-work-projection.ts`, `use-thread-messages.ts`, `use-agent-stream.ts`), `web/src/routes/$budId/budId.spec.md`.

### Current implementation (facts)
- **A compaction is not a message.** `AgentContextCompactor.compact` writes one
  `agent_context_checkpoint` row (`status`, `trigger`, `reason`, `phase`,
  `summary`, `replacement_history`, `compacted_through_message_id` /
  `_created_at`, `compacted_through_llm_call_id` / `_created_at`,
  `input_tokens_before`, `estimated_tokens_after`, owner/tenant stamps,
  `created_at`, `completed_at`). The loader reads that table to rebuild the
  model's context; `GET /api/threads/:id/messages` reads only `message`.
- **The transcript only knows about a compaction live.** `AgentService.
  compactConversationIfNeeded` emits `agent.compaction_start` /
  `agent.compaction_done` / `agent.compaction_failed` runtime events
  (`agent-service.ts` ~1160–1225). The web turns `done`/`failed` into a
  `ChatTimelineNotice` in route state (`contextCompactionNotices`, seeded
  `[]`, reset on thread switch), rendered by `ChatTimelineNoticeRow` as a
  centered pill sorted by `finished_at`. Refresh → gone. The summary text is
  never on the stream (it is bounded but can be several KB) and is readable
  only in the Model view (`checkpoint_summary` provenance).
- **Precedent to mirror — reasoning rows.** `TranscriptWriter` inserts a
  `role: "reasoning"` message with `displayRole`, owner stamp, and
  `metadata { artifact_kind: "reasoning", model_visible: false, turn_id,
  llm_call_id, … }` (`transcript-writer.ts` ~440), then emits
  `agent.reasoning_done` carrying the serialized row so the web upserts it
  live. It does **not** call `recordThreadMessageMetadata`, so previews,
  `message_count` and attention/notifications skip it by construction; the
  loader skips `role === "reasoning"` on replay; the web projection folds it
  into work groups; mobile has documented handling
  (`reference/IOS_AGENT_MESSAGE_DURATION_METADATA_HANDOFF.md`).
- **Roles are TypeScript-only.** `message.role` is `text("role", { enum })`
  with no DB CHECK, so a new role needs no migration (verify: `pnpm
  db:generate` must produce no SQL).
- **Loader behavior for unknown roles.** `appendStoredMessage` only handles
  `reasoning` (skip), `tool`, `assistant`, `user`, `system`; any other role
  falls through and is ignored — a new role is invisible to the model by
  construction.
- **Web ingestion of rows.** The thread store upserts by `client_id`
  (`upsertMessage`); `agent.message` / `agent.reasoning_done` events deliver
  serialized rows; `projectTimeline` treats non-work, non-final rows as
  top-level `kind: 'message'` rows and breaks work groups around them.

## Objective
Every completed compaction appears in the transcript as a durable,
expandable divider at the point it happened — collapsed: the pill we show
today ("Context compacted · pre-turn · 245k → 12k"); expanded: the summary
the model now carries in place of the earlier history — surviving refresh,
pagination, thread switches, and mobile, with no new read endpoint.

Acceptance:
- One `message` row per completed checkpoint, written in the same place the
  checkpoint is recorded; live sessions see it arrive through the existing
  stream; reloads see it through `GET /messages`.
- The model never sees the row (loader ignores it); previews, `message_count`,
  attention, and push notifications ignore it; the context budget is
  unaffected (it is not in the loader output).
- Existing checkpoints are backfilled so history is consistent.
- Old web (no renderer for the role) and mobile degrade to "row not shown";
  old service (no row, no `message` on the event) keeps the session-only
  pill in new web.

## Design / Approach

### 1. Row shape (`role: "compaction"`)
Add `"compaction"` to `messageRoleValues`. A dedicated role rather than
`system` + metadata because the loader replays `system` rows and the web's
debug flag shows them; a new role is ignored by the loader and
self-describing to every client.

```ts
{
  clientId: generateMessageClientId(),          // uuidv7, like other agent rows
  threadId,
  role: "compaction",
  displayRole: "Context compacted",
  content: checkpoint.summary ?? "",            // what the model now carries
  createdByUserId: checkpoint.createdByUserId,  // owner stamp (AGENTS.md §4.6)
  tenantId: checkpoint.tenantId,
  createdAt: checkpoint.completedAt ?? checkpoint.createdAt,
  metadata: {
    artifact_kind: "context_compaction",
    model_visible: false,
    status: "completed",
    checkpoint_id, turn_id, trigger, reason, phase,
    tokens_before: input_tokens_before, tokens_after: estimated_tokens_after,
    compacted_through_message_id, compacted_through_llm_call_id,
    source_provider, source_model, source_reasoning_effort,
    replacement_history_message_count,
  },
}
```
`created_at` = checkpoint completion, which chronologically lands right
after the last message the model still saw verbatim (for `mid_turn`,
between the tool rows of that turn — correct: that is where the cut is).
The checkpoint table remains the model's source of truth; the row is a
transcript artifact. Failed compactions get **no row** in v1 (the stream's
red pill stays session-only; revisit if failures need history).

### 2. Write path
- `TranscriptWriter.insertCompactionMessage(checkpoint)` (next to the
  reasoning-row writer; same insert/serialize helpers; no
  `recordThreadMessageMetadata`, no attention, no notification).
- Called from `AgentContextCompactor.compact` immediately after
  `recordCompletedContextCheckpoint` succeeds, in the same try block, so a
  checkpoint without a row is only possible on a crash between the two
  statements — and the backfill script (below) is idempotent, so running it
  also repairs that. (Wrapping both in one transaction is a small follow-up
  if the repository grows a `tx` parameter; not required for v1.)
- `compact` returns the serialized row; `agent-service` attaches it to
  `agent.compaction_done` as an additive `message` field (same pattern as
  `agent.reasoning_done.message`).

### 3. Exclusions (mirror reasoning rows)
- Loader: add an explicit early `return` for `role === "compaction"` next to
  the reasoning skip (already ignored by fall-through; make it deliberate and
  tested).
- Previews / `message_count` / attention / notifications: nothing to change —
  the writer never calls those paths for this row. Add a test that the
  thread's `message_count` and `last_message_preview` are unchanged after a
  compaction row is written.
- `context-budget` breakdown: unaffected (not in loader output); the model
  view is unaffected for the same reason.
- Thread title service: unaffected (reads user/assistant rows only — verify
  in the change).

### 4. Read path & contracts
- `GET /api/threads/:id/messages` returns the row as-is (`serializeMessage`
  is role-agnostic). `SerializedMessage.role` / web `ApiMessage.role` unions
  gain `"compaction"`.
- `docs/proto.md`: document the row (role, `display_role`, metadata keys), the
  rule "clients must not treat `role: "compaction"` as assistant text for
  previews, notifications, or replay", and the additive
  `agent.compaction_done.message`.
- **Mobile**: an unknown role must render as nothing, not crash. Confirm with
  the iOS side before the service ships (their duration-metadata handoff
  shows role switching; unknown-role tolerance is the one contract risk).
  Write a short handoff note in `reference/` mirroring the reasoning-row one.

### 5. Web
- `agent-work-projection.ts`: `role === 'compaction'` is never a work
  message and never a final assistant; it stays a top-level `kind: 'message'`
  row (groups break around it, so a mid-turn compaction shows the turn's
  work as two groups around the cut — accurate).
- `chat-timeline.tsx`: new `CompactionRow` for `role === 'compaction'`:
  collapsed = today's pill (phase + `tokens_before → tokens_after`,
  relative time on hover); expanded = the summary rendered with
  `MarkdownContent` under a caption "This is what the model now remembers of
  the conversation above", plus a small "compacted through …" line. Expansion
  is ephemeral, keyed by `client_id`, like work groups. Failed compactions
  keep the existing notice path.
- Live: `handleCompactionDone` upserts `event.message` into the thread store
  when present (via the existing upsert callback) and only falls back to
  `appendContextCompactionNotice` when the event has no `message` (older
  service). Remove nothing else; the notice list keeps serving failures.
- `use-thread-messages.ts`: no change needed for ingestion; ensure the
  optimistic/reconcile paths ignore the new role (they key on user/assistant).
- Bottom-follow: the projection's visible-structure key already includes new
  message rows.

### 6. Backfill
`service/src/scripts/backfill-compaction-messages.ts` (register as
`pnpm backfill:compaction-messages`; document in `scripts.spec.md`):
- Select completed checkpoints with no `message` row whose
  `metadata->>'checkpoint_id'` matches (left join / not-exists), in batches.
- Insert rows exactly as §1 with `created_at = completed_at ?? created_at`.
- Idempotent (safe to re-run; also repairs crash gaps from §2), `--dry-run`
  prints counts, batch size via env like the client-id backfill.
- Run once after the service deploy, before/independent of the web deploy.

## Spec Files to Update
- [x] `service/src/db/db.spec.md` — new `message.role` value (no migration; note the verification)
- [x] `service/src/agent/agent.spec.md` — `transcript-writer.ts` (compaction row), `context-compactor.ts` (writes the row, returns it), `conversation-loader.ts` (explicit skip), tests
- [x] `service/src/routes/threads/threads.spec.md` — `messages.ts` row kinds, `agent.ts` event field
- [x] `service/src/scripts/scripts.spec.md` — backfill script
- [x] `docs/proto.md` — row contract + additive event field
- [x] `web/src/lib/lib.spec.md` — `ApiMessage.role`
- [x] `web/src/features/threads/threads.spec.md` — projection + stream handling
- [x] `web/src/components/workbench/workbench.spec.md` — `CompactionRow`
- [x] `web/src/routes/$budId/budId.spec.md` — notice state now failure-only
- [x] `reference/` — mobile handoff note for the new role
- [x] `design/context-compaction.md` — "visible transcript" section: compactions are now visible rows

## Impacted Contracts
- [x] WSS protocol — none
- [x] SSE events — `agent.compaction_done` gains additive `message`
- [x] DB schema — none (TS enum only; `pnpm db:generate` must be a no-op — verify)
- [x] Agent tools — none
- [x] REST — `GET /messages` returns a new `role: "compaction"` row kind
- [x] Web UI — expandable compaction row; notice state reduced to failures
- [x] Mobile — must tolerate the new role (confirm before shipping)

## Test Plan
- Service: compactor writes exactly one row per completed checkpoint with
  the metadata above and owner/tenant stamps; the row is attached to
  `agent.compaction_done`; loader ignores `compaction` rows (model context
  byte-identical); `message_count` / preview / attention untouched; messages
  route returns the row; backfill inserts only for checkpoints lacking a row
  and is idempotent (second run inserts 0); `db:generate` produces no SQL.
- Web: projection keeps compaction rows top-level and splits groups around
  them; `CompactionRow` collapsed/expanded presentation (pure helper,
  node-tested); `handleCompactionDone` upserts the row when present and
  falls back to a notice when absent; fixture snapshot in
  `__fixtures__/agent-work/` with a mid-turn compaction.
- Manual: trigger a compaction on a long thread → row appears live; refresh
  → still there, expandable; older page load keeps it in place; iOS build
  shows nothing for the row and does not crash.

## Rollout
1. Mobile tolerance confirmed (or shipped) for unknown roles.
2. Service deploy (writes rows; old web ignores the role, shows nothing).
3. Run the backfill once (idempotent).
4. Web deploy (renders rows; keeps the notice fallback for any older service).
No daemon involvement; no schema migration.

## Effort
- Service: writer + compactor hook + event field + loader skip + tests ≈ ½ day.
- Backfill script + spec ≈ 2 hours.
- Web: projection rule + `CompactionRow` + live upsert + tests ≈ ½ day.
- Mobile confirmation: a message to the iOS side; no code in this repo.
