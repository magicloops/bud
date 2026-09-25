# Debug: Working threads trade places

## Environment and reproduction
Web sidebar, two threads performing interleaved agent tool calls/commentary.

## Observed
`ThreadPanel` sorts `last_activity_at`; `recordThreadMessageMetadata` advances it
for intermediate assistant segments and tool results, not just conversation events.
The server thread-list query uses the same noisy field.

## Expected and proposed fix
Use a separate persisted conversation timestamp, changed only on creation, user
message insertion and final assistant response. Preserve generic activity and
preview/count behavior. See ../design/stable-thread-ordering.md and
../plan/stable-thread-ordering.md for ownership, rollout and validation.

## Local validation notes

`pnpm --dir service db:push` prompted about recreating the unrelated
`agent_invocation_dedupe_key` constraint on 294 rows, including a truncation
option. No truncation or unrelated change was applied. Applied only the reviewed
0043 SQL (column/backfill/triggers) in one local transaction, matching existing
trigger-migration workflow. Drizzle generated checked-in snapshot/journal.

Initial route tests failed because older fixtures omitted `lastConversationAt`:
`last_conversation_at: undefined` was an extra serialized field. Updated fixtures
and expected responses to verify the actual timestamp. All 43 route/schema tests
then passed. Exact PostgreSQL migration and ordering tests also passed.

## Mobile validation

Simulator build passed using `xcodebuild -project Bud.xcodeproj -scheme Bud
-destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`
(with an isolated derived-data directory).

Debug simulator tests selected `ThreadOrderingTests`, `NetworkChatDTOsTests`,
`ChatStoreTests`, and `ChatPersistenceTests`: 127 passed, four failed. The failures
are model-selection expectations in these ChatStore tests:
- `testBootstrapKeepsSavedModelAndReasoningWhenCatalogSupportsThem`: gpt-5.4 vs claude-opus-4-7.
- `testCreateConversationWithOpeningMessageCreatesThreadAndSends`: nil vs claude-opus-4-6.
- `testLocalModelUnavailableReloadsScopedCatalogAndShowsBackendMessage`: nil vs gpt-5.4.
- `testSendMessageFailureRemovesOptimisticTurnAndReturnsRestorableDraft`: nil vs claude-sonnet-4-6.

Re-ran those four with `xcodebuild ... -configuration Debug ... test` and individual
`-only-testing:BudTests/ChatStoreTests/<name>` selectors on an isolated unchanged
`b4f3b64` worktree: all four failed with identical assertions (exit 65). These
predate the ordering change; no unrelated model-selection code was changed.
Logs: `/tmp/bud-mobile-order-tests.log` and `/tmp/bud-mobile-order-baseline.log`.
