# Debug: Thread Title Generation Leaves `thread.title` NULL

## Environment

- Date: 2026-04-08
- Surface: web new-thread flow (`/$budId/new` -> `POST /api/threads` -> `POST /api/threads/:thread_id/messages`)
- Backend: local Bud service
- Agent model default: `claude-opus-4-5`
- Title model target: hardcoded `claude-haiku-4-5`
- User-confirmed runtime constraint: `ANTHROPIC_API_KEY` is present in the running environment and other Claude calls already work

## Repro Steps

1. Open the web app and create a new thread.
2. Send the first user message.
3. Wait for the normal assistant response to complete or begin streaming.
4. Inspect the created thread via the DB or `GET /api/threads/:thread_id`.
5. Observe that `thread.title` is still `NULL`.
6. Observe that no error-level service log line explains the missing title.

## Observed

- First-message write succeeds.
- Normal assistant flow succeeds, so `agentService.startUserMessage(...)` is not failing in the visible request path.
- `thread.title` remains `NULL`.
- We do not currently have enough logging to tell which internal title-generation branch executed.
- Lack of error logs does **not** mean lack of title-generation failures:
  - thrown title-generation failures are logged at `warn`, not `error`
  - some no-op branches return silently with no log line at all

## Expected

- On the first durable user message for a thread, the backend should generate a short 3-5 word summary title with Haiku 4.5.
- The conversation row should eventually persist that title in `thread.title`.
- A `thread.title` SSE event should be eligible to appear on the existing thread agent stream during the first assistant turn.

---

## Current Implementation Review

### 1. Trigger point is present and runs after the assistant turn is queued

In `service/src/routes/threads.ts`, the title path is launched only after:

1. the user message row is inserted
2. thread metadata is updated
3. `await agentService.startUserMessage(...)` succeeds

Then the route starts the title work as fire-and-forget:

```ts
void threadTitleService.maybeGenerateFromFirstUserMessage(...).catch(...)
```

Implication:

- the main request can succeed while title generation fails or no-ops
- the missing title is not evidence that the main assistant flow is broken

### 2. `maybeGenerateFromFirstUserMessage(...)` has two silent early-exit branches

In `service/src/agent/thread-title-service.ts`:

- `isFirstUserMessageWithoutTitle(...)` returns `false` with **no log**
- `persistThreadTitle(...)` can return `null` with **no log**

That means the full path can do nothing and leave `thread.title` as `NULL` without emitting any warning or error if:

- the first-user-message predicate unexpectedly fails
- the conditional `UPDATE ... WHERE thread.title IS NULL` updates zero rows

### 3. Logged failure paths are `warn` only, not `error`

There are two logged failure classes today:

- route-level catch in `threads.ts`:
  - `"Thread title generation failed"`
- normalization rejection in `thread-title-service.ts`:
  - `"Skipping empty or invalid generated thread title"`

Both are `warn` level.

Implication:

- watching only error-level logs would make the feature appear silent even when it is failing

### 4. Title normalization is stricter than many natural title outputs

`normalizeGeneratedThreadTitle(...)` currently rejects:

- blank output
- output shorter than 3 words
- output longer than 80 chars

It also truncates longer outputs to 5 words.

This is stricter than many plausible good thread titles. Examples the model might reasonably return:

- `Fix login`
- `Terminal reconnect`
- `Agent stream bug`

The first two are only 2 words and would be rejected.

Implication:

- if Haiku frequently returns 1-2 word titles despite the prompt, the thread will remain untitled
- this would show up as a `warn`, not an `error`

### 5. The Anthropic request shape used here is different from the normal agent path

The title generator calls Anthropic with:

- `tools = []`
- `toolChoice = "none"`

But the Anthropic adapter transforms `"none"` into:

```ts
{ type: "auto" }
```

and still sends `tool_choice` even when `tools` is omitted.

Implication:

- this title-generation request shape is not the same as the normal Opus agent loop
- other Claude calls working does **not** prove this exact Haiku request shape is valid
- if Anthropic rejects `tool_choice` when no tools are supplied, the title path would fail independently of the normal agent path

### 6. There is very little observability around the title path

What we do **not** currently log:

- entry into `maybeGenerateFromFirstUserMessage(...)`
- result of `isFirstUserMessageWithoutTitle(...)`
- raw model text returned by Haiku
- normalized title candidate
- whether `persistThreadTitle(...)` updated a row or not

Implication:

- we cannot currently distinguish between:
  - predicate returned false
  - model call failed
  - model returned a rejected title
  - conditional DB update affected zero rows

---

## Hypotheses

### Hypothesis 1: Haiku is returning 1-2 word titles that our normalizer rejects

**Confidence:** Medium-High

Why:

- this path specifically requires 3-5 words
- many natural short thread titles are only 1-2 words
- rejection leaves `thread.title` null
- current behavior would only emit a `warn`, not an `error`

What would confirm it:

- logging the raw Haiku output shows short titles like `Fix login` or `Terminal reconnect`

### Hypothesis 2: The Anthropic title request is invalid because we send `tool_choice` with no tools

**Confidence:** Medium

Why:

- the title path uses an Anthropic request shape that differs from the normal agent flow
- `toolChoice: "none"` is transformed into `{ type: "auto" }`, not omitted
- `tools` is empty/omitted
- other working Claude calls do not exercise this exact combination

What would confirm it:

- warning logs or instrumentation show Anthropic returning a 4xx validation error on the title request

### Hypothesis 3: The title path is silently returning before generation because the first-user predicate is false

**Confidence:** Low-Medium

Why:

- this is one of the only fully silent branches in the implementation
- the current code emits no log if `isFirstUserMessageWithoutTitle(...)` returns `false`

Why it is not the leading theory:

- for a brand new thread with a single first user message, the predicate should normally be true

What would confirm it:

- instrumentation shows `thread.title` is still null, but the first-user-message query is not matching the just-inserted `message_id`

### Hypothesis 4: The DB update is silently affecting zero rows

**Confidence:** Low-Medium

Why:

- `persistThreadTitle(...)` returns `null` without logging when the conditional update does not match
- that would leave `thread.title` null with no error line

Why it is not the leading theory:

- on a fresh thread, nothing else should normally have set `thread.title` first

What would confirm it:

- instrumentation shows title generation and normalization succeeded, but the conditional update returned zero rows

### Hypothesis 5: We are looking at the wrong log severity

**Confidence:** High

Why:

- current title-generation failures are logged as `warn`, not `error`
- the user report specifically mentioned “no errors in the service logs”

What would confirm it:

- warning-level logs already contain title-generation failures that were simply not included in the earlier check

---

## Findings Summary

- The trigger path exists and is wired into the message route.
- The feature is intentionally non-blocking, so normal assistant behavior does not tell us whether title generation succeeded.
- The implementation currently has both:
  - **silent no-op paths**
  - **warn-only failure paths**
- Given the user confirmation that Anthropic is already working elsewhere, the most likely remaining causes are:
  1. normalization rejecting Haiku output
  2. this specific Anthropic request shape failing
  3. a silent early exit with no instrumentation

## 2026-04-29 Follow-up

A later review found a concrete implementation drift from [plan/thread-title-generation/implementation-spec.md](../plan/thread-title-generation/implementation-spec.md): `resolveThreadTitleModel()` chose `config.defaultModel` first and then fell back through all registered provider models, even though the plan required Anthropic `claude-haiku-4-5` only.

That meant environments with OpenAI configured, or with a slow/default frontier model configured, could send title generation through a model that was never intended for this path and still had only the title path's 8s timeout and 24-token output budget.

Patch direction:

- Resolve only `claude-haiku-4-5` for thread titles.
- Return `null` when Anthropic/Haiku is unavailable instead of falling back to OpenAI or another provider.
- Add structured logs for eligibility skips, unavailable Haiku, title model candidates, invalid generated output, conditional update misses, and successful persistence.
- Keep the root `TODO.md` follow-up for a future fast OpenAI title model/provider-selection policy so OpenAI-only users can still get generated titles.

Focused verification command run after the patch:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/thread-title-service.test.ts
```

Exact failure:

```text
TAP version 13
# Subtest: normalizeGeneratedThreadTitle trims labels and punctuation
ok 1 - normalizeGeneratedThreadTitle trims labels and punctuation
# Subtest: normalizeGeneratedThreadTitle preserves longer titles
ok 2 - normalizeGeneratedThreadTitle preserves longer titles
# Subtest: normalizeGeneratedThreadTitle accepts short titles
ok 3 - normalizeGeneratedThreadTitle accepts short titles
# Subtest: collectResponse accumulates streamed title text deltas
ok 4 - collectResponse accumulates streamed title text deltas
# Subtest: resolveThreadTitleModel uses Anthropic Haiku 4.5 when Anthropic is configured
ok 5 - resolveThreadTitleModel uses Anthropic Haiku 4.5 when Anthropic is configured
# Subtest: resolveThreadTitleModel does not fall back to OpenAI when Anthropic is unavailable
ok 6 - resolveThreadTitleModel does not fall back to OpenAI when Anthropic is unavailable
# Subtest: generateTitle invokes Anthropic Haiku 4.5
not ok 7 - generateTitle invokes Anthropic Haiku 4.5
  error: "Cannot read properties of undefined (reading 'logger')"
  stack: |-
    generateTitle (/Users/adam/bud/service/src/agent/thread-title-service.ts:258:12)
    async TestContext.<anonymous> (/Users/adam/bud/service/src/agent/thread-title-service.test.ts:149:18)
# Subtest: generateTitle returns null when Anthropic is not configured
not ok 8 - generateTitle returns null when Anthropic is not configured
  error: "Cannot read properties of undefined (reading 'logger')"
  stack: |-
    generateTitle (/Users/adam/bud/service/src/agent/thread-title-service.ts:218:12)
    TestContext.<anonymous> (/Users/adam/bud/service/src/agent/thread-title-service.test.ts:166:22)
1..8
# tests 8
# pass 6
# fail 2
```

The test harness was then fixed by binding the reflected private `generateTitle` method to the `ThreadTitleService` instance before invoking it. Rerunning the same command passed:

```text
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The first service build after that exposed a TypeScript-only control-flow issue in the test:

```text
src/agent/thread-title-service.test.ts(150,34): error TS2339: Property 'model' does not exist on type 'never'.
src/agent/thread-title-service.test.ts(151,34): error TS2339: Property 'toolChoice' does not exist on type 'never'.
src/agent/thread-title-service.test.ts(152,38): error TS2339: Property 'reasoning' does not exist on type 'never'.
```

The test was adjusted to capture `ModelConfig` values in an array, which gives TypeScript a stable non-null indexed value after asserting one invocation. Final verification:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/thread-title-service.test.ts
pnpm --dir /Users/adam/bud/service build
```

Both commands passed.

---

## Proposed Fix

Minimal diagnostic patch before changing feature behavior:

1. Add structured logs around:
   - title-generation entry
   - first-user predicate result
   - raw/normalized title candidate
   - conditional update success vs zero-row result
2. Reproduce with one fresh thread and inspect warn/info logs.

If the diagnosis confirms normalization rejection:

- relax acceptance from `3-5` words to `2-5` words, or add a fallback trimming strategy for short-but-valid outputs

If the diagnosis confirms Anthropic request-shape failure:

- omit `toolChoice` entirely when `tools.length === 0`

If the diagnosis confirms a silent predicate/update no-op:

- keep the guard, but log the branch result so failures stop being invisible

## Spec Files Potentially Affected

- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `docs/proto.md` only if stream semantics change
