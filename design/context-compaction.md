# Design: Context Compaction

Status: Draft

Audience: Backend, web/mobile clients, LLM-provider owners

Last updated: 2026-05-23

Implementation plan: [../plan/automatic-compaction/implementation-spec.md](../plan/automatic-compaction/implementation-spec.md)

## 1. Goal

Keep long-running Bud threads usable when their model-visible history approaches
the selected model's context window.

Bud should compact model context without deleting or hiding the user-visible
transcript. The visible chat history remains append-only; compaction changes the
service-owned replay state used to build future LLM requests.

Primary goals:

- prevent provider calls from failing because the reconstructed conversation is
  too large
- preserve enough task state for the next model call to continue correctly
- keep current system prompt, tool schemas, auth, terminal state, and ownership
  context fresh after compaction
- make compaction durable so service restart does not lose the installed model
  replay state
- keep provider switching and same-provider reasoning replay explicit

Non-goals for the first implementation:

- full transcript search or retrieval-augmented recall
- lossless compression of every prior message/tool/result
- exposing compacted replacement history through `/messages`
- provider-specific remote compaction as the required baseline
- user-editable compaction prompts

## 2. Reference Summary

[reference/CONTEXT_COMPACTION_SPEC.md](../reference/CONTEXT_COMPACTION_SPEC.md)
recommends a portable baseline:

- ask a model to write a concise handoff summary from the current live history
- install a shorter replacement history instead of blindly deleting old turns
- keep harness context out of the durable summary and re-inject it fresh
- persist the replacement history, not just the summary text
- use provider token usage where available, with approximate estimates as a
  fallback
- retry compaction by trimming the oldest temporary request items when the
  compaction request itself exceeds the context window

The most important adaptation for Bud is that our durable transcript and our
model-visible replay state should separate. The chat timeline is product data;
the compacted checkpoint is agent runtime data.

## 3. Current Implementation Review

### 3.1 Conversation reconstruction is unbounded

`AgentConversationLoader.loadWithDiagnostics(...)` currently starts every agent
turn with the Bud Agent system prompt and then loads all persisted messages for
the thread:

- `service/src/agent/conversation-loader.ts`
- `message` rows are ordered by `created_at`
- same-provider `llm_call_item` assistant output is replayed when available
- provider switches fall back to visible canonical transcript rows
- tool rows are replayed from `message.content`

There is no checkpoint boundary, message limit, token budget, or model-window
guard before the constructed `CanonicalMessage[]` is sent to the provider.

### 3.2 The in-turn history also grows without bounds

`AgentService.runAgentFlow(...)` mutates an in-memory `conversation` array during
one turn:

- after each provider response with tool calls, it pushes the assistant output
  blocks
- after tool execution, it pushes one user message containing the tool-result
  blocks
- the next loop sends the larger conversation back to the provider

This means a single tool-heavy turn can exceed context even if the thread was
within budget at turn start.

### 3.3 Token usage exists but is not used for guardrails

Provider adapters normalize final usage into `TokenUsage`:

- OpenAI maps `input_tokens`, `output_tokens`, `reasoning_tokens`, and cached
  input tokens
- Anthropic maps input/output plus cache creation/read counters
- `recordLlmCall(...)` persists usage on `llm_call.usage`

The model catalog already exposes `contextWindowTokens`, but the agent does not
compare usage against that window.

### 3.4 Provider ledger is valuable but needs checkpoint filtering

The `llm_call` / `llm_call_item` ledger preserves same-provider reasoning,
tool-use, and assistant output items. This is important for quality and cache
behavior, but today `loadProviderLedgerMessages(...)` considers the whole
thread.

Compaction must establish a replay boundary so the loader uses:

1. fresh system prompt
2. latest active checkpoint replacement history
3. message and provider-ledger rows after the checkpoint boundary

It must not replay compacted older ledger output on top of the summary.

### 3.5 Existing context sync is related but not sufficient

`ContextSyncService` may inject `message.role = "system"` rows before a user
message when terminal state changes. Those rows are useful current context, but
old context-sync rows should not be preserved blindly after compaction.

The compacted replacement history should either rely on a fresh context-sync
row after compaction, or include a service-built current terminal context note.

## 4. Recommended Architecture

### 4.1 Add a durable checkpoint table

Add a service-owned table, tentatively `agent_context_checkpoint`.

Recommended columns:

| Column | Purpose |
|--------|---------|
| `checkpoint_id` | ULID primary key |
| `thread_id` | owning thread |
| `trigger` | `manual`, `auto`, `model_downshift` |
| `reason` | `user_requested`, `context_limit`, `model_downshift`, `context_error_retry` |
| `phase` | `standalone_turn`, `pre_turn`, `mid_turn` |
| `implementation` | `local_summary` initially; remote variants later |
| `status` | `completed`, `failed`, `canceled` |
| `source_provider` / `source_model` | model used to summarize |
| `source_reasoning_effort` | selected reasoning level used for summary |
| `summary` | raw handoff summary text |
| `replacement_history` | JSONB canonical messages installed after compaction, excluding the base system prompt |
| `compacted_through_message_created_at` / `compacted_through_message_id` | message boundary |
| `compacted_through_llm_call_created_at` / `compacted_through_llm_call_id` | provider-ledger boundary |
| `input_tokens_before` | best known active-context tokens before compaction |
| `estimated_tokens_after` | estimated replacement-history size after compaction |
| `error` | bounded failure details |
| `tenant_id` / `created_by_user_id` | standard ownership fields |
| `created_at` / `completed_at` | lifecycle timestamps |

Only the latest completed checkpoint for a thread is active. Failed attempts are
kept for diagnostics but ignored by conversation loading.

### 4.2 Keep checkpoints out of the visible transcript

Do not insert summary checkpoints as normal `message` rows for automatic
compaction. Otherwise users will see implementation artifacts in chat history,
mobile unread math, and push attention logic.

If the product wants user-visible disclosure, emit a stream event or render a
non-transcript UI marker.

### 4.3 Build future model input from checkpoint plus delta

Extend `AgentConversationLoader` so it loads:

1. the normal Bud Agent system prompt
2. latest completed checkpoint `replacement_history`, if present
3. regular message rows after the checkpoint message boundary
4. same-provider ledger rows after the checkpoint LLM-call boundary

The replacement history should use canonical Bud messages. The base system
prompt should not be stored inside it, because system prompt and tool guidance
must always come from current code.

### 4.4 Local summary is the first implementation

Implement a new service collaborator, tentatively `AgentContextCompactor`, that
uses the normal provider interface with no tools:

1. clone the current canonical conversation
2. append a synthetic user message containing the compaction prompt
3. invoke the selected provider/model with `toolChoice: "none"` or no tools
4. collect the assistant text
5. build replacement history from recent real user messages plus a prefixed
   checkpoint summary
6. persist the completed checkpoint

Default prompt:

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

Recommended summary prefix in replacement history:

```text
Another Bud Agent model compacted earlier context for this thread. Use this checkpoint to continue the task without repeating completed work. The visible transcript still exists in the product, but your model-visible context has been shortened. Summary:
```

Use a user-role checkpoint message in model-visible replacement history so both
providers can consume it consistently. Mark it with metadata in the checkpoint
JSON, not in `message`.

## 5. Triggering Strategy

### 5.1 Auto pre-turn compaction

Before the first provider call of a new agent turn, compare the latest active
context token estimate to the selected model's auto-compaction threshold.

Recommended threshold:

- default to 90 percent of `contextWindowTokens`
- allow a lower service env override later
- clamp any configured value to at most 90 percent
- if no model context window is known, skip auto compaction unless an explicit
  threshold is configured

Bud-specific timing choice:

- simplest first implementation: run this at the start of `runAgentFlow(...)`,
  after the new user row is persisted
- stronger but more invasive implementation: compact before inserting the new
  user row, then insert the user row after the checkpoint

The stronger option better matches the reference spec, but it requires moving
provider work into the message route before durable user-message insertion. The
simpler option is acceptable if compaction has retry-by-trimming behavior.

### 5.2 Auto mid-turn compaction

After each provider response and tool-result append, if another provider call is
needed, check the budget before the next `invokeModel(...)`.

This is required because a long command output or many tool calls can exceed
context inside one active turn.

Mid-turn replacement history must include:

- fresh current terminal/session context
- recent real user messages
- current in-turn assistant/tool-result state summarized by the checkpoint

After installing the checkpoint, replace the mutable in-memory `conversation`
array before the next provider call.

### 5.3 Model downshift compaction

When a user selects a model with a smaller context window, compare the current
token estimate with the new model's threshold. If the current history is too
large and the previous selected model has a larger window, compact with the
previous model before sampling with the new model.

This affects:

- `POST /api/threads/:thread_id/messages` with an explicit smaller model
- `PATCH /api/threads/:thread_id/model-preference`

Open question: whether `PATCH` should proactively compact immediately or only
mark the thread so the next message compacts before sampling.

### 5.4 Manual compaction

Manual compaction needs a product decision.

Options:

- add `POST /api/threads/:thread_id/agent/compact`
- treat a slash command such as `/compact` as a command, not a normal user
  transcript row
- defer manual compaction until automatic compaction is reliable

Recommendation: defer public manual compaction for the first backend tranche,
but keep the compactor service callable from tests and admin scripts.

## 6. Replacement History Rules

Replacement history should be compact, provider-neutral, and free of stale
harness context.

Recommended construction:

- exclude the normal Bud Agent system prompt
- exclude model-visible tool schemas; providers receive current tools from
  `AgentModelRunner`
- exclude old context-sync/system rows by default
- exclude prior checkpoint summary messages
- preserve recent real user messages up to a fixed budget, initially around
  20,000 estimated tokens
- append a single checkpoint summary message with the stable prefix
- include a fresh current terminal context note for mid-turn compaction

For "real user messages", use durable `message.role = "user"` rows that are
not generated fallback rows from system/tool mechanisms unless explicitly
useful. The first implementation can include all user rows except known
checkpoint/fallback markers, then tighten once we see real transcripts.

If a selected recent user message exceeds the remaining recent-message budget,
truncate it with an explicit marker:

```text
[Earlier user message truncated during context compaction.]
```

## 7. Token Accounting

Bud has three token sources:

- provider-reported `llm_call.usage.input_tokens`
- provider-reported output/reasoning tokens
- rough estimates for new local messages/tool results not yet sampled

Recommended first pass:

1. Use the latest completed normal agent `llm_call.usage.input_tokens` as the
   best exact provider request size.
2. Add an estimate for messages/tool results appended since that call.
3. For estimates, start with `ceil(chars / 4)` plus a small per-message
   overhead.
4. Treat tool schema/system prompt overhead as part of provider-reported input
   after at least one call; before the first call, estimate them.

Longer-term option: add provider-specific token counters if the SDKs expose
stable APIs.

## 8. Context-Window Failure Handling

Provider calls can still fail because the compaction request itself is too big.

The compactor should catch provider context-window errors, trim the temporary
compaction request from the oldest side, and retry.

Trimming rules:

- never trim the synthetic compaction prompt
- preserve the initial system prompt until no other item remains
- if trimming removes a tool-use message, remove matching tool-result blocks
- if trimming removes a tool-result block, remove the matching tool-use block
- prefer keeping recent user messages and existing checkpoint summaries

Known implementation need: provider adapters should normalize context-limit
errors into a typed `ProviderContextWindowError` so the compactor can distinguish
retryable trimming from auth, rate-limit, network, or provider bugs.

## 9. Stream And Client Contract

Automatic compaction does not require a transcript row.

Recommended additive SSE events:

- `agent.compaction_start`
- `agent.compaction_done`
- `agent.compaction_failed`

Suggested payload fields:

- `turn_id`
- `checkpoint_id`
- `trigger`
- `reason`
- `phase`
- `tokens_before`
- `tokens_after`

Clients may render this as a subtle activity marker. Existing clients can ignore
the events.

Manual compaction, if added later, should return the checkpoint id and emit the
same event family.

## 10. Provider Ledger Interaction

Compaction introduces a new replay boundary. Provider-ledger helpers need to
support filtering by the active checkpoint.

Recommended changes:

- `AgentConversationLoader` resolves the latest checkpoint first
- `loadStoredRows(...)` filters to rows after the message boundary
- `loadProviderLedgerMessages(...)` filters to calls after the LLM-call boundary
- reconstruction diagnostics include checkpoint metadata:
  - active checkpoint id
  - compacted-through boundaries
  - replacement-history message count
  - whether provider-native replay starts after checkpoint

Compaction summarization calls should not be replayed as normal assistant
history. Either do not record them in `llm_call`, or record them with a distinct
request mode/status and explicitly filter them out.

Recommendation: first implementation records compaction details on
`agent_context_checkpoint` only. Add `llm_call` recording later if we need
provider usage/cache diagnostics for compaction calls.

## 11. Ownership And Security

The checkpoint table is browser-adjacent service data and must follow thread
ownership.

Rules:

- `agent_context_checkpoint.created_by_user_id` inherits the owning thread user
- all manual/admin reads resolve the thread through `getAuthorizedThread(...)`
- automatic compaction uses the owner already passed into `AgentService`
- checkpoint summaries may contain user data and tool output, so do not expose
  raw replacement history to clients by default
- tenant fields stay nullable for now, consistent with current schema

## 12. Rollout Plan

### Phase 1: Durable checkpoint foundation

- add `agent_context_checkpoint` schema and migration
- add repository helpers for latest completed checkpoint and checkpoint writes
- extend specs for DB, agent, routes, and migrations
- add unit tests for ownership stamps and latest-checkpoint selection

### Phase 2: Loader boundary

- teach `AgentConversationLoader` to load checkpoint replacement history plus
  post-checkpoint transcript/ledger rows
- add diagnostics for checkpointed reconstruction
- add tests covering provider-native replay after checkpoint and provider switch
  fallback after checkpoint

### Phase 3: Local compactor

- implement `AgentContextCompactor`
- add compaction prompt and replacement-history builder
- add context-window retry trimming
- test old tool-use/tool-result pairing trimming
- test empty-summary fallback

### Phase 4: Automatic triggers

- add pre-turn and mid-turn budget checks
- replace in-memory `conversation` after mid-turn compaction
- add token-estimate telemetry
- add failure behavior: if compaction fails because the provider cannot compact,
  fail the agent turn with a clear error instead of sending an over-limit request

### Phase 5: Client observability and optional manual API

- add optional `agent.compaction_*` SSE events
- decide whether to expose manual compaction
- update web/mobile client types if needed

### Phase 6: Optional provider-native compaction

- evaluate OpenAI/Anthropic dedicated compaction primitives when available
- keep local summary as the fallback and test baseline

## 13. Choices To Make

1. **Pre-user vs post-user pre-turn compaction**: compact before inserting the
   new user row for stricter safety, or at `runAgentFlow` start for lower
   implementation risk.
2. **Manual compaction UX**: route, slash command, admin-only, or deferred.
3. **Checkpoint visibility**: invisible by default, stream marker only, or a
   non-transcript timeline marker.
4. **Prompt location**: inline constant in the compactor, or extract into the
   future prompt-management system.
5. **Compaction LLM ledgering**: checkpoint table only, or also record
   compaction model calls in `llm_call` with a filtered request mode.
6. **Current terminal context after compaction**: rely on context sync, preserve
   latest context-sync row, or generate a fresh service-owned context note.
7. **Token threshold configurability**: hard-coded 90 percent initially, or add
   service env config in the first tranche.

## 14. Known Unknowns

- exact provider error shapes for context-window failures across OpenAI and
  Anthropic SDKs
- whether provider-reported usage consistently includes tool schema and system
  overhead for every streamed response
- how often same-timestamp message/LLM-call boundary ties occur in production
- whether old provider-native reasoning blocks remain useful after a summary
  checkpoint or should always be dropped before the boundary
- whether context summaries should preserve full terminal output snippets for
  long-running debugging tasks or only high-level outcomes
- whether users will need an explicit "compact now" affordance during very long
  manual sessions
- how aggressive repeated compactions can be before task quality noticeably
  drops

## 15. Initial Acceptance Criteria

- a thread that exceeds the selected model threshold compacts before the next
  provider request
- a long tool loop can compact mid-turn and continue with the installed
  replacement history
- visible `/messages` history remains unchanged by automatic compaction
- service restart uses the latest completed checkpoint when reconstructing
  context
- provider ledger rows before the checkpoint are not replayed on top of the
  summary
- checkpoint rows are owner-stamped and not visible to non-owners
- compaction failures fail clearly and do not silently drop transcript history
- tests cover prompt summary creation, replacement-history persistence, loader
  reconstruction from checkpoint, and context-window retry trimming
