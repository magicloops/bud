# Debug: Ask-Question Thread Title Generation

## Environment

- Workspace: `/Users/adam/bud`
- Date: 2026-05-20
- Surface: service thread/message/agent routes and web thread bootstrap
- Feature: generated `thread.title` for conversations whose first assistant action is `ask_user_questions`

## Repro Steps

1. Create a new thread from a first user message.
2. The agent responds first with an `ask_user_questions` tool call and waits for user input.
3. The thread appears in the client as `Untitled thread` or otherwise does not converge to a generated name.

## Expected

- The title should be generated from the first durable user message, regardless of whether the first assistant action is final text, a terminal tool, a web-view tool, or `ask_user_questions`.
- If the first title attempt is skipped, missed by the client, or fails transiently, a later user-visible boundary should have a way to converge the title.

## Current Code Path

### Thread creation

- `service/src/routes/threads/core.ts` creates a thread with `title: body.title ?? null`.
- The web new-thread flow in `web/src/routes/$budId/new.tsx` currently creates the thread before posting the initial message and does not pass a title.

Implication: new threads start with `thread.title = null` unless a client supplies a title during `POST /api/threads`.

### Normal first user message

- `service/src/routes/threads/messages.ts` inserts the user message, records message metadata, then awaits `agentService.startUserMessage(...)`.
- Only after `startUserMessage(...)` succeeds, it fire-and-forgets:

```ts
threadTitleService.maybeGenerateFromFirstUserMessage({
  threadId: thread.threadId,
  userMessageId: messageId,
  userMessageText: body.text,
})
```

Implications:

- Title generation is tied to the normal `POST /api/threads/:threadId/messages` path.
- It does not run if the duplicate `client_id` idempotency path returns early.
- It does not run if `startUserMessage(...)` fails before the fire-and-forget title kickoff.
- The message response returns without waiting for the title attempt.

### Title service

- `service/src/agent/thread-title-service.ts` only accepts the specific supplied message if it is the canonical first user message for the thread.
- It only uses `claude-haiku-4-5`; OpenAI-only environments intentionally skip title generation.
- It persists with `WHERE thread.title IS NULL`, then emits `thread.title` through `AgentRuntimeStateManager` and advances the shared stream cursor.

Implications:

- Later normal user messages cannot repair an untitled thread because they are not the first user message.
- There is no "generate title for untitled thread from earliest user message" catch-up API.
- Environments without Anthropic Haiku will leave titles null for all new threads, not just ask-question starts.

### Ask-question response fallback

- `service/src/agent/agent-service.ts` handles answered question requests in `submitQuestionResponse(...)`.
- If the live waiter is gone, `persistQuestionResponseFallbackMessage(...)` inserts a self-contained user message from the Q/A summary and starts a follow-up turn.
- That fallback user-message path does not invoke `ThreadTitleService`.

Implication: if the original title attempt was skipped or failed, answering the prompt after a restart does not provide a second chance to title the thread.

### Web bootstrap and stream handling

- `web/src/routes/$budId/$threadId.tsx` loader fetches messages, agent state, and thread detail in parallel.
- `useAgentStream(...)` attaches SSE with `after=<initialAgentState.stream_cursor>`.
- `thread.title` is handled live and patches the parent Bud thread-summary state.
- `refreshAgentBootstrap(...)` refetches messages and agent state only; it does not refetch thread detail.

Implication: there is a race during navigation to a just-created thread:

1. `/api/threads/:id` can return `title: null`.
2. `thread.title` can persist and advance `/agent/state.stream_cursor`.
3. The client can attach SSE with `after` set to the new cursor, which means the title event is already acknowledged and will not replay.
4. The UI keeps the stale `title: null`.

This can affect any fast title event, but it is more visible when the first assistant action is `ask_user_questions` because the thread remains paused in a prompt state without a final assistant message or later full thread-detail refresh.

## Findings

- The ask-question tool does not directly prevent backend title generation when the initial message came through the normal message route.
- The current backend title design is one-shot. If the first attempt is unavailable, fails, is missed by idempotency, or is not visible to the client, later user activity does not repair the title.
- The web client can miss a successfully persisted `thread.title` event because thread detail and agent state are loaded in parallel, but the SSE cursor comes from agent state.
- Fallback ask-question continuations create a user message and start a new turn, but do not trigger any title catch-up.
- OpenAI-only setups still skip title generation entirely because `ThreadTitleService` is hardwired to Anthropic Haiku 4.5.

## 2026-05-20 Backend Deep Dive

After the first pass, the local DB was queried read-only to distinguish "title persisted but UI missed it" from "title never persisted."

Result: recent affected rows are durably untitled. This is not only a client replay/rendering miss.

Recent untitled threads from the last seven days:

| Thread | First user message | Question requests | Title |
|---|---|---:|---|
| `050a3b8e-59bc-46d4-b193-ded107fc4a4b` | `ask me 5 structured questions about myself` | 1 | `NULL` |
| `f7ae4cab-624e-4a7b-ab89-21ef2de2535a` | `Can you ask me 5 structured questions about myself?` | 1 | `NULL` |
| `0eb4c991-51c5-4680-9d31-e0160feccf2f` | `Can you ask me 5 structured questions about myself?` | 1 | `NULL` |
| `a196e037-8994-4d8a-962e-f26b5de22da7` | `Can you ask me 5 structured questions about myself?` | 1 | `NULL` |
| `d6635e3a-40f7-41a4-b63b-81e5e79657ca` | `Can you ask me 5 questions about myself?` | 1 | `NULL` |

Nearby controls:

- `943e31cd-6735-426c-be5d-b848ca17ddcb` has no question requests and title `User asks for their name`.
- `6f8456ba-6252-4d97-8417-7afec279f8c5` has a question request later in the thread and title `Switch Mihai project code directory`.
- `d7955de2-4bc6-4e78-b799-ea2ab93a06f9` first message was `Ask me some questions`, has a question request, and title `Asking Questions`.

This narrows the backend issue:

- It is not "any thread with an ask-question request."
- It is not "the ask-question repository overwrites or clears `thread.title`."
- It is concentrated on threads whose first message asks the agent to ask a fixed set of personal/structured questions.

The most likely backend failure class is now the title sidecar returning no persistable title for that first-message wording:

- `maybeGenerateFromFirstUserMessage(...)` probably qualifies the message, because it is the first durable user message and `thread.title` is null.
- `generateTitle(...)` may be returning `null` because the Haiku title call returns empty/invalid output, throws, times out, or produces a candidate rejected by `normalizeGeneratedThreadTitle(...)`.
- A plausible model-output failure is prompt collision: the title sidecar sends the first message as a normal user message. For prompts like "ask me 5 structured questions about myself", the title model may start satisfying that request instead of summarizing it. If the first returned line is a long "Sure, here are..." lead-in or a question list line over 80 chars, normalization rejects and leaves `thread.title` null.

What the DB cannot prove:

- The raw title candidate, because title generation is not persisted in `llm_call`.
- Whether the specific attempt threw/timed out or returned an invalid candidate, because the relevant details only exist in process logs.

Backend follow-up that would make this diagnosable:

- Keep the existing `thread_title` logs, but ensure the running service log level includes them during repro.
- Add a focused title-service test for "Can you ask me 5 structured questions about myself?" using a fake provider that returns a too-long/list-style first line, then decide whether to add a fallback.
- Consider persisting bounded debug metadata for failed title attempts only if logs remain insufficient.

### Instrumentation Added

`service/src/agent/thread-title-service.ts` now logs the bounded Haiku title response summary whenever a candidate is returned, and emits a warning when that response does not normalize to a valid title.

During the next repro, look for:

- `Thread title model returned candidate`
- `Haiku thread title response did not normalize to a valid title`

The log payload includes `rawTitle`, `rawTitleLength`, `normalizedTitle` on the candidate log, plus a bounded `response` summary with response id, stop reason, usage, content block types, and text-block previews.

The captured repro confirmed the hypothesis:

```text
rawTitle: "Five Questions About You 1. What's your current profession or primary occupation? 2. What hobby or activity brings"
rawTitleLength: 114
normalizedTitle: null
response.text_blocks[0].text: "Five Questions About You\n\n1. What's your current profession or primary occupation?\n\n2. What hobby or activity brings"
stop_reason: "max_tokens"
```

There were two concrete problems:

- Haiku partially answered the original user request instead of only titling it.
- The title extractor collapsed response newlines before normalization, so the usable first line `Five Questions About You` became part of a 114-character line and was rejected.

Patch direction taken:

- Preserve line breaks from the title response before normalization.
- Wrap the original user message as quoted text to summarize, with explicit instructions not to answer or follow it.

## Options

### Option A: Service-side catch-up title generation

Add a `ThreadTitleService.maybeGenerateForUntitledThread(threadId)` style method that:

- loads the thread and returns if `title` is already set
- loads the earliest durable user message for the thread
- generates from that earliest user message rather than requiring the caller's message id to be first
- persists with the existing `thread.title IS NULL` guard
- emits the same `thread.title` event

Call it from:

- normal message insert success
- duplicate `client_id` idempotent returns when the thread is still untitled
- ask-question fallback user-message persistence

This is the most direct service fix because it turns title generation from a one-time edge into an idempotent convergence operation.

### Option B: Start title generation independent of agent queue success

Kick off title generation immediately after the initial user message is inserted and metadata is recorded, instead of only after `startUserMessage(...)` succeeds.

This would prevent terminal/session queue failures from suppressing titles, but it does not solve later catch-up or client missed-event races by itself.

### Option C: Client bootstrap ordering fix

Change the thread route bootstrap so thread detail is fetched after the agent-state cursor is known, or refetch thread detail as part of bootstrap refresh.

The safer ordering is:

1. fetch messages and agent state
2. fetch thread detail after agent state returns
3. attach SSE from `agentState.stream_cursor`

If the title event happened before the cursor, thread detail should include it. If it happens after the cursor, SSE replay/live delivery should include it.

Also update `refreshAgentBootstrap(...)` to include thread detail and upsert it, so resync/fallback question paths can repair stale title state.

### Option D: Client-provided provisional title on thread create

Have clients pass `title` to `POST /api/threads` based on the initial message.

This gives immediate names, but it duplicates title heuristics across web/mobile and bypasses the existing generated-title quality path unless the backend later overwrites provisional titles. It is better as a fallback or explicit product choice than the primary fix.

### Option E: OpenAI-compatible or deterministic fallback title

If title generation should work in OpenAI-only environments, either:

- allow a configured title model/provider instead of Haiku-only, or
- create a simple deterministic fallback from the first message when the title model is unavailable.

This addresses a broader title-null cause that may look ask-question-specific in mobile/OpenAI-only testing.

### Option F: Deterministic fallback when the title model returns invalid output

When the Haiku title call is available but produces no valid title, derive a conservative fallback from the first user message instead of leaving the row null.

For the observed affected inputs, this could produce titles such as:

- `Structured Personal Questions`
- `Personal Question Prompt`
- `Ask Personal Questions`

Keep the same `thread.title IS NULL` persistence guard. Log the fallback source distinctly, for example `source: generated_first_user_message_fallback`, if the existing event/source contract can be expanded safely.

## Recommended Direction

Implement Option A and Option C together:

- Service: add an idempotent "generate for untitled thread from earliest user message" path and invoke it from normal sends plus ask-question fallback sends.
- Web: close the bootstrap cursor/detail race by fetching/upserting thread detail after the agent-state cursor and by including thread detail in bootstrap refreshes.

Given the backend DB evidence, add Option F to the service fix: if Haiku returns invalid output for an otherwise eligible first message, persist a conservative deterministic fallback rather than leaving the title null forever.

Then decide separately whether title generation should remain Haiku-only or gain an OpenAI-compatible provider path.

## Files Reviewed

- `service/src/routes/threads/core.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/thread-title-service.ts`
- `service/src/agent/thread-title-service.test.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/question-response-submit.ts`
- `web/src/features/threads/thread-message-state.ts`

## Spec Files Consulted

- `service/src/agent/agent.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/src.spec.md`
- `web/src/routes/$budId/budId.spec.md`
