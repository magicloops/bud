# Ask User Questions Tool Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Service Contract And Persistence

### Contract Validation

- [ ] valid one-question boolean request normalizes successfully
- [ ] valid multi-question mixed request normalizes successfully
- [ ] duplicate question ids are rejected
- [ ] unsupported question kind is rejected
- [ ] invalid default answer is rejected
- [ ] choice question without choices is rejected
- [ ] duplicate choice ids are rejected
- [ ] response with unknown question id is rejected
- [ ] response with wrong answer kind is rejected
- [ ] skipped response is accepted for every kind
- [ ] tool result repeats each question before its answer

### Route And Ownership

- [ ] owner can submit a response
- [ ] unauthenticated request returns `401`
- [ ] signed-in non-owner returns `404`
- [ ] request id from another owned thread returns `404` for the current thread route
- [ ] duplicate `client_response_id` retry returns idempotent success
- [ ] different second response after answered request is rejected

## Phase 2: Agent Runtime Tool Flow

### Live Continuation

- [ ] model can emit `ask_user_questions`
- [ ] service persists a pending question request
- [ ] `/agent/state` shows `phase: "waiting_for_user"`
- [ ] `agent.tool_call` includes `name: "ask_user_questions"` and request args
- [ ] answer submission resolves the live waiter
- [ ] agent receives one structured tool result
- [ ] agent continues and produces a final assistant response
- [ ] transcript includes one completed question tool row
- [ ] provider ledger stores the tool result item

### Cancel And Fallback

- [ ] cancel while waiting marks the turn canceled
- [ ] cancel marks pending question request canceled
- [ ] answering a canceled request fails with stable error
- [ ] after simulated service restart/no waiter, answer submission persists fallback user message
- [ ] fallback user message starts a new agent turn
- [ ] fallback message repeats each question before each answer

## Phase 3: Reference Web Client

### Pending Prompt UI

- [ ] pending prompt renders from live `agent.tool_call`
- [ ] pending prompt renders from `/agent/state` after refresh
- [ ] boolean answer can be submitted
- [ ] single-choice answer can be submitted
- [ ] multi-choice answer can be submitted
- [ ] text answer can be submitted
- [ ] number answer can be submitted
- [ ] individual question skip can be submitted
- [ ] skip all can be submitted
- [ ] unsupported kind displays a stable unsupported/skipped state

### Reconciliation

- [ ] live tool-result continuation replaces/removes pending prompt row
- [ ] completed Q/A summary renders in transcript
- [ ] fallback response refreshes transcript/runtime state
- [ ] final/canceled turn clears pending prompt row
- [ ] reconnect/resync does not duplicate prompt rows

## Phase 4: Notifications, Docs, And Validation

### Notifications

- [ ] `human_input_requested` updates thread attention state when implemented
- [ ] notification summary includes the thread while prompt is unseen when implemented
- [ ] push outbox row is enqueued with correct kind/dedupe when implemented
- [ ] answering/canceling prompt prevents stale repeated human-input notifications

### Docs / Specs

- [ ] `docs/proto.md` describes the shipped route and payloads
- [ ] service specs describe new agent/runtime/route/db behavior
- [ ] web specs describe prompt rendering and submission behavior
- [ ] migration spec lists the generated migration
- [ ] design doc is still accurate or has a supersession note
- [x] mobile handoff exists if native adoption is expected

### Commands

- [ ] service unit/route tests run
- [ ] web pure tests run
- [ ] service build/lint run if implementation touches build-sensitive code
- [ ] web build/lint run if implementation touches UI code

## Phase 5: Integration Test Hardening

### Service Route And Repository

- [ ] owner response integration test passes
- [ ] unauthenticated response integration test passes
- [ ] signed-in non-owner response integration test passes
- [ ] request/thread mismatch integration test passes
- [ ] idempotent retry integration test passes
- [ ] answered/canceled conflict integration tests pass
- [ ] invalid response payload integration tests pass
- [ ] persisted row assertions pass for status, response, tool result, idempotency key, and acting user stamps

### Agent Continuation

- [ ] live continuation integration test passes
- [ ] runtime event/state assertions pass for `waiting_for_user`
- [ ] transcript completed-tool-row assertions pass
- [ ] provider ledger tool-result assertions pass
- [ ] fallback continuation integration test passes
- [ ] cancel while waiting integration test passes
- [ ] malformed model ask payload fail-closed test passes

### Web Prompt Integration

- [ ] pending prompt from live stream test passes
- [ ] pending prompt from `/agent/state` bootstrap test passes
- [ ] response payload tests pass for all v1 question kinds
- [ ] per-question skip and skip-all tests pass
- [ ] submit reconciliation tests pass for live, fallback, already-answered, and error responses
- [ ] completed renderer tests pass for answered, skipped, and malformed payloads

### End-To-End Smoke

- [ ] real-provider ask/answer/continue smoke passes or is explicitly deferred
- [ ] refresh while waiting smoke passes
- [ ] duplicate submit smoke passes
- [ ] cancel while waiting smoke passes
- [ ] fallback continuation smoke passes
- [ ] ownership regression smoke passes
- [ ] terminal-tool regression smoke passes

### Phase 5 Commands

- [ ] service route/repository integration command run
- [ ] service agent continuation integration command run
- [ ] web prompt integration command run
- [ ] service build run after integration test changes
- [ ] web build run after web test changes

## Phase 6: Prompt Guidance And Question Count

- [x] system prompt avoids multiple-question markdown-list guidance
- [x] system prompt tells the model to convert long question checklists into `ask_user_questions`
- [x] system prompt keeps normal markdown questions scoped to exactly one simple freeform answer
- [x] model-facing `ask_user_questions.questions` schema omits `maxItems`
- [x] service request normalization accepts more than five questions
- [x] focused service tests pass

### Phase 6 Commands

- [x] `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/conversation-loader.test.ts src/agent/model-runner.test.ts src/agent/user-question-contracts.test.ts`

## Phase 7: Follow-Up Supersession Service Contract

- [ ] normal message send while `waiting_for_user` closes pending request as skipped
- [ ] message-create response contains only `message_id` and `client_id`
- [ ] all pending question rows for the thread are closed as answered/skipped
- [ ] live supersession records a completed skipped tool row
- [ ] live supersession emits `final.status: "succeeded"` with `reason: "superseded_by_user_message"`
- [ ] live supersession emits no assistant `message_id` or `text`
- [ ] old waiting turn does not issue another provider call
- [ ] follow-up turn starts after old waiting turn is terminal
- [ ] duplicate message `client_id` retry does not re-run supersession
- [ ] explicit answer racing with follow-up supersession has one accepted winner
- [ ] explicit skip-all from the question card continues the original turn
- [ ] explicit cancel still marks pending requests canceled

### Phase 7 Commands

- [ ] service route/repository tests run after implementation
- [ ] service agent continuation tests run after implementation

## Phase 8: Waiting-For-User Client UX

- [ ] `/agent/state.phase = "waiting_for_user"` shows pending prompt without global loading spinner
- [ ] live `agent.tool_call` for `ask_user_questions` shows pending prompt without global loading spinner
- [ ] composer remains enabled while a prompt is pending
- [ ] send button spinner appears only during message dispatch
- [ ] follow-up message send uses `POST /api/threads/:thread_id/messages`
- [ ] follow-up message send does not call the question-response route
- [ ] `agent.tool_result` plus `final.status: "succeeded"` clears pending prompt UI
- [ ] explicit answer and explicit skip-all still submit through the question-response route
- [ ] mobile handoff describes normal-message recovery from stale prompts

### Phase 8 Commands

- [ ] web thread/message-state tests run after implementation
- [ ] web build or focused UI tests run after implementation if touched

## Phase 9: Human-Input Attention Resolution

- [ ] attention anchor decision recorded
- [ ] prompt creation produces human-input attention when implemented
- [ ] notification summary reflects pending human input when implemented
- [ ] push outbox row is deduped by question request id when implemented
- [ ] explicit answer resolves human-input attention when implemented
- [ ] explicit skip-all resolves human-input attention when implemented
- [ ] follow-up supersession resolves human-input attention when implemented
- [ ] follow-up supersession suppresses stale human-input push when implemented
- [ ] newer assistant-completed attention survives stale prompt resolution
- [-] Phase 9 validation deferred until attention anchor implementation

## Notes

- This checklist validates v1 only. Secret input, file answers, date/time controls, branching prompts, and durable provider-native suspended-turn replay are out of scope.
- If any build/run command fails, capture the exact command and output in `debug/` and stop for human guidance.
