# Debug: Shared client state implementation

## Environment

Local service/web checkout, October 2026. No production mutation authorized.

## Reproduction / observed

Message cursors encode and decode PostgreSQL timestamps through JS Date, losing
microseconds. See `ios-agent-work-missing-final-answer.md` for the literal-row
reproduction. Ordinary agent state reconstructs context while web polls visible
durable threads every five seconds.

## Expected

Exact pagination, cheap state and event-driven inventory convergence under
`plan/client-state-performance/implementation-spec.md`.

## Proposed fix

Keep exact timestamp text in cursors; separate budget reads; complete committed
inventory hints before removing polling. Record test/build failures below.

## Validation failures resolved

`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/routes/threads/message-cursor.test.ts src/routes/threads/open.test.ts src/routes/threads/registration.test.ts src/routes/threads/messages.test.ts src/routes/threads/agent-question-response.test.ts` from service initially passed 18/20; two old direct-handler mocks failed with `TypeError: reply.header is not a function`. Added the response-header seam and corrected the active-budget fixture's missing turn identity. PostgreSQL precision traversal passed on its first run.

`pnpm db:push` (service) proposed an unrelated `thread_creation_receipt_owner_key`
unique-constraint change and asked whether to truncate a table with two rows.
Canceled with Ctrl-C (exit 1); no truncation approved or performed. Generated
`0050_pending_request_notifications.sql` with
`pnpm db:generate --custom --name pending_request_notifications`, then applied its
exact SQL in a transaction to the hostname-verified local database. Trigger-only
DDL is not representable in schema.ts; deploy through `pnpm db:migrate`.

The web command `pnpm exec tsx --test src/features/threads/client-state-refresh.test.tsx src/features/threads/use-context-budget.test.tsx src/features/threads/use-pending-requests.test.tsx src/features/threads/thread-message-state.test.ts src/components/workbench/streaming-parity.test.tsx`
passed 29/30 but JSX rendering failed with `ReferenceError: React is not defined`.
This invocation omitted the application's JSX config. Re-running the same command
with `--tsconfig tsconfig.app.json` (as used by `test:render`) passed 30/30.

`pnpm lint` (web) exits 1 with 12 errors/4 warnings in untouched files:
unused variables in automation-proposal-summary.test.tsx, browser/mobile-viewer.test.tsx,
browser/viewer.test.tsx, threads/client-recovery.test.tsx, question-response-submit.test.ts,
and workbench-view.ts; react-refresh/only-export-components in automation-proposal-summary.tsx
and workbench/chat-pane-resize.tsx; react-hooks/rules-of-hooks in routes/data.tsx.
Warnings are hook dependencies in routes/$budId.tsx and routes/automations.tsx.
The affected paths have no task diff. ESLint over all nine changed/new web code/test
files passes. Kept unrelated cleanup out of this performance change.
