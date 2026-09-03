# Plan: Model view — show the system prompt and the fully expanded transcript

Status: Implemented 2026-09-03.

## Context
- Design: `design/full-transcript-mode.md` (approach **B**: a read-only,
  server-built "model context" document). This plan implements the viewing
  half only. Bud/thread prompt overrides (copy-on-write, replace/append,
  base-version tracking) are explicitly deferred; the seams below are where
  they plug in.
- Related spec files: `service/src/agent/agent.spec.md`
  (`conversation-loader.ts`, `system-prompt.ts`),
  `service/src/routes/threads/threads.spec.md`,
  `web/src/components/workbench/workbench.spec.md`,
  `web/src/features/threads/threads.spec.md`, `web/src/routes/routes.spec.md`,
  `docs/proto.md`, `plan/init-auth/validation-checklist.md`.

## Objective
A per-thread toggle between the standard chat transcript and a **Model
view** that shows, in exact order, what the next model request will contain:
the system prompt, any runtime (developer-style) system messages, the
compaction summary if one is in effect, every user/assistant message, every
tool call and tool result, and reasoning summaries — nothing collapsed.

Acceptance:
- Toggle is one click from the thread; state is per thread and per session
  (not persisted), like work-group expansion.
- The document is produced by the **same loader path the agent uses**, so it
  is right after compaction, in bud-offline mode, with the CWD suffix, and
  with retired-tool remaps.
- Each block shows its role, where it came from (prompt / runtime / summary /
  transcript / provider replay), and an estimated token count consistent with
  the context popover's breakdown.
- Owner-only; non-owners get `404`; additive API; mobile unaffected.
- Adding bud/thread prompt overrides later touches one resolver and one
  provenance field, nothing in the view.

## Design / Approach — "simple is robust"

### Service

**1. One resolver for the system prompt (the future seam).**
Today the loader reads `AGENT_SYSTEM_PROMPT` directly. Introduce
`resolveSystemPrompt({ threadId, budId })` in `system-prompt.ts` returning:

```ts
{ text: string; scope: "default"; version: string /* sha256 of text */ }
```

It returns the file today. The loader and the compactor's replacement-history
builder call it instead of the constant. Later, overrides add
`scope: "bud" | "thread"`, an `override_id`, and a lookup before the file —
callers do not change. Hash the file once at boot (`AGENT_SYSTEM_PROMPT_VERSION`).

**2. Provenance side-channel in the loader (no behavior change).**
`LoadedConversation` gains `sources: MessageSource[]`, parallel to
`messages`, where

```ts
type MessageSource =
  | { kind: "system_prompt"; scope: "default"; version: string }
  | { kind: "runtime_instruction" }
  | { kind: "checkpoint_summary"; checkpoint_id: string }
  | { kind: "checkpoint_history"; checkpoint_id: string }   // recent user msgs / terminal context carried by the checkpoint
  | { kind: "message"; message_id: string; client_id: string; role: string }
  | { kind: "ledger"; llm_call_id: string }
  | { kind: "repair" }                                        // synthesized tool_result for an orphaned call
```

Implementation: the loader already pushes from six distinct places
(`system prompt`, replacement history, ledger, stored rows via
`appendStoredMessage` (1–2 messages per row), `repairOrphanedToolCalls`).
Replace bare `messages.push(...)` with a local `emit(message, source)`; make
`repairOrphanedToolCalls` accept/return the parallel array so injected results
are tagged `repair`. Runtime instructions are added by
`applyRuntimeInstructions` in `agent-service.ts`; give it the same
side-channel (it inserts after the first system message — the endpoint mirrors
that placement). `messages` stays byte-identical to today; existing callers
ignore `sources`.

**3. Endpoint.** `GET /api/threads/:threadId/model-context` in
`routes/threads/` (owner-scoped via `requireAuthorizedThreadAccess`):

```jsonc
{
  "model": "gpt-5.6-sol", "provider": "openai",
  "generated_at": "…", "turn_active": false,
  "compaction": { "checkpoint_id": "…", "compacted_through_message_id": "…" } | null,
  "system_prompt": { "scope": "default", "version": "sha256:…" },
  "tools": [{ "name": "terminal_run", "description": "…", "parameters": {…} }],
  "tool_schema_tokens": 1600,
  "messages": [
    { "index": 0, "role": "system", "source": { "kind": "system_prompt", … },
      "content": [{ "type": "text", "text": "…" }], "estimated_tokens": 7900 },
    …
  ],
  "estimated_input_tokens": 108000,
  "context_budget": { …the same snapshot as /agent/state… }
}
```

- Builds via `resolveEffectiveModelSelection` → `loadWithDiagnostics` (same
  provider/model/reasoning inputs as the agent) →
  `applyRuntimeInstructions` with `agentService.getEnvironmentForThread`.
  Tools from `resolveAgentToolsForEnvironment(environment)`.
- `estimated_tokens` per message = the breakdown estimator applied to a
  one-message array (`estimateCanonicalMessagesTokens([m])`); the sum equals
  the popover's `message_estimated_tokens` by construction.
- Content is returned **in full** (canonical blocks, snake_case). No
  server-side clamping in v1: tool outputs are already bounded by the tools,
  and even a full Sol window is ~1 MB gzipped to a few hundred KB, fetched on
  demand only. If that ever hurts, add `?max_block_chars=` later — the shape
  does not change.
- Never includes provider secrets or raw provider request bodies (the loader
  only produces canonical messages).

### Web

**4. Mode toggle.** New `transcriptMode: 'chat' | 'model'` state in
`routes/$budId/$threadId.tsx` (session-only, reset on thread switch), distinct
from `viewMode` (which picks the right-hand pane). Control: a two-segment
`Chat | Model` toggle in the workspace top bar beside the view tabs, plus a
"View what the model sees" link in the context popover footer. The composer
and send button stay as they are in both modes.

**5. `ModelContextView` component** (`components/workbench/model-context-view.tsx`):
- Fetches the document on entering the mode and again when `agentState.active`
  flips to false or a compaction event arrives; while a turn is active shows
  "Refreshing when the turn ends" over the last document (stale banner).
- Renders one block per message in order: sticky mini-header (role, source
  badge, token count), a left rail colored with the popover palette (system
  purple, user/assistant pink, tool call orange, tool output cyan, reasoning
  green, checkpoint gray), body as preformatted text (`whitespace-pre-wrap`,
  mono) — no markdown rendering, so the prompt reads exactly as sent.
  `tool_use` blocks show name + pretty-printed args; `tool_result` blocks
  clamp at 40 lines with "Show all"; images as thumbnails.
- A collapsed "Tools · 7 · 1.6k tokens" block at the top listing names and
  descriptions.
- A banner at the checkpoint summary: "Earlier history was replaced by this
  summary (compacted through …)". Header line: "as of &lt;time&gt; ·
  &lt;N&gt; messages · &lt;tokens&gt; of &lt;budget&gt;".
- Long documents: render with the existing virtual-friendly structure
  (plain list; blocks clamped) — no virtualization library in v1.
- Pure helper `buildModelViewBlocks(doc)` (node-tested) does grouping,
  labels, colors, token labels; the component is thin.

**6. Reuse, not duplication.** Palette from `theme-colors.ts`
(`DEFAULT_AVATAR_COLORS` / gray) via the same mapping the popover uses
(`context-budget-meter-state.ts` exports it); token formatting via
`formatRoundedTokenCount`.

### What this deliberately does not do
- No editing, no override storage, no per-user prompt (design §4.D step 2).
- No "expand all" inside Chat view; the Model view is the expanded view.
- No live streaming of the model view mid-turn.
- Tool schemas and the compaction prompt are shown read-only, unchanged.

### Seams that make the override work a small follow-up
- `resolveSystemPrompt` is the only place that knows where the prompt comes
  from; overrides = a lookup inside it plus `scope`/`override_id` on its
  result.
- `source.kind: "system_prompt"` already carries `scope` + `version`; the UI
  badge switches on it ("Default prompt v…" → "Bud prompt" / "Thread prompt").
- The document shape is stable; editing adds `PUT`/`DELETE` routes, not a new
  read model.
- `transcriptMode` is an enum; an "Edit prompt" surface can hang off the
  Model view header without touching the chat pipeline.

## Spec Files to Update
- [x] `service/src/agent/agent.spec.md` — `system-prompt.ts` (resolver, version), `conversation-loader.ts` (provenance side-channel), `agent-service.ts` (`applyRuntimeInstructions` provenance)
- [x] `service/src/routes/threads/threads.spec.md` — model-context endpoint + test
- [x] `docs/proto.md` — endpoint contract (§ REST) and `source` kinds
- [x] `web/src/components/workbench/workbench.spec.md` — `model-context-view.tsx`, top-bar toggle
- [x] `web/src/features/threads/threads.spec.md` — `model-context` fetch hook / helper
- [x] `web/src/routes/$budId/budId.spec.md` — `transcriptMode` state
- [x] `web/src/lib/lib.spec.md` — `ApiModelContext` types
- [x] `plan/init-auth/validation-checklist.md` — new owner-scoped read
- [x] `design/full-transcript-mode.md` — mark B implemented, overrides deferred

## Impacted Contracts
- [ ] WSS protocol — none
- [ ] SSE events — none (the view refetches on existing `final` / compaction events)
- [ ] DB schema — none
- [ ] Agent tools — none
- [x] REST — new `GET /api/threads/:threadId/model-context` (additive)
- [x] Web UI — transcript mode toggle + Model view

## Test Plan
- Service: loader provenance array is parallel to `messages` for fixture
  threads before and after compaction, including a repaired orphan call;
  `resolveSystemPrompt` returns the file with a stable version hash; endpoint
  returns the loader output + runtime instruction placement, per-message
  tokens summing to the budget snapshot's `message_estimated_tokens`,
  `404` for signed-in non-owners, `401` unauthenticated; all existing
  loader/compactor tests unchanged (byte-identical `messages`).
- Web: `buildModelViewBlocks` labels/colors/tokens per source kind and
  compaction banner placement; toggle resets on thread switch; stale/refresh
  on turn end. Manual: long tool-heavy thread, a compacted thread, an
  offline bud (runtime instruction visible).

## Rollout
- Service first or web first — either order works; the web hides the toggle
  if the endpoint returns `404`. No daemon change. Mobile unaffected.
- Product decision baked in: the full default prompt is visible to every
  signed-in user. (Confirmed as the intent.)

## Effort
- Service: resolver + provenance + endpoint + tests ≈ 1 day.
- Web: toggle + view + helper + tests ≈ 1–1.5 days.
