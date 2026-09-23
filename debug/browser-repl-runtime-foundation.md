# Browser REPL runtime foundation

Date: 2026-09-23. Status: Phase 1 complete internally; not agent-enabled.

Related: [design](../design/browser-repl.md),
[implementation plan](../plan/bud-owned-browser/repl-implementation.md),
[daemon spec](../bud/src/browser/browser.spec.md),
[helper spec](../bud/browser-helper/browser-helper.spec.md).

## Environment and scope

macOS arm64, prepared Node v24.21.0, Rust development build. Tests use isolated
workers and an opt-in disposable Chrome profile with a local HTTP fixture.
No real account, application rows, running service or installed user profile
was changed. Service tests use disposable schemas in local PostgreSQL. No new capability or model-facing tool is advertised.

The worker and daemon bridge implement persistent JavaScript, bounded output,
per-operation page locking and cooperative authority checks. Service receipts and
parking/Return continuation are now included. Typed facade, full snapshot
materialization, images/artifacts and actual-agent comparison remain later phases.

## Evaluation investigation

An initial inspector `Runtime.evaluate` experiment supported persistent bindings
and await but failed ordinary `import()` with
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. The implementation instead uses Node's
built-in REPL evaluator, with discarded interactive output and explicit
`repl.write`. No JavaScript parser or inspector network endpoint was added.

The pinned evaluator routes exceptions through its internal `_domain` rather
than always invoking the evaluation callback. That dependency is confined to the
worker and covered by synchronous exception, rejected await, import, syntax-error
and late-callback tests. Revalidate these tests when updating managed Node.
Lexical redeclarations follow Node REPL semantics; reuse `var` or reassign existing
variables. The last expression is never implicitly emitted.

The first `cargo check --manifest-path bud/Cargo.toml --lib` failed with `E0624`
because the child orchestration module's methods were private. Narrow
`pub(super)` visibility fixed the manager calls. The first
`cargo clippy --manifest-path bud/Cargo.toml --lib -- -D warnings` reported
`collapsible_if` and `nonminimal_bool`; those conditions were simplified, including
an existing checkpoint condition next to the changed control path.

## Limits and lifecycle decisions

- One lazy worker per admitted workspace, separate from Chrome and the semantic
  helper. Existing limits allow two active workspaces per Bud.
- Managed Node with 128 MiB old-space, 64 KiB code, 3 MiB framed IPC, 32 KiB UTF-8
  text and a separate 2 KiB exception ceiling. Heap limit is not an RSS cap.
- Cell deadline is the lesser of the request's remaining lifetime and 30 seconds.
- Private takeover closes admission immediately and uses one shared two-second
  graceful drain window. A stalled worker is killed; process exit must be confirmed
  within 500 ms. The waiting takeover allows at most one second to regain each
  worker mutex. Failure to confirm termination prevents acquisition acknowledgement.
- Idle reconnect and clean takeover retain bindings. Active interruption resets
  the worker without replay. Canceling before evaluation preserves its heap.
- Every bridge call uses current connection, workspace, invocation, sequence and
  authority checks. Old asynchronous calls cannot join a later cell. Supported
  operations are tracked even if user code forgets to await them.
- Final output is withheld after takeover or superseded invocation/workspace.
  Safe completion/reset metadata remains available for future receipt integration.
  A failed mixed cell may already have caused effects and is not a safe rejection.

This is trusted host JavaScript, not a sandbox. Cooperative facade guarantees do
not constrain arbitrary filesystem, process or network access from imported Node
modules. No page text or generated JavaScript is added to operational logs.

## Validation

Managed Node used below:
`/Users/adam/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node`.

- `node --test bud/browser-helper/repl-worker.test.mjs` using that executable:
  7 passed. Covers bindings, await/imports, errors, explicit bounded output,
  worker isolation, unawaited operations and late callbacks.
- `BUD_BROWSER_NODE=<managed-node> cargo test --manifest-path bud/Cargo.toml
  --lib repl_execution -- --nocapture`: 13 reported passing; 12 executed without
  Chrome, while the opt-in live test returned early in this command.
- The live test is run separately with `BUD_BROWSER_EXECUTABLE` set to
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and
  `cargo test --manifest-path bud/Cargo.toml --lib live_repl_operations
  -- --nocapture`: verifies observation, retained bindings through private
  takeover/Return, stale-reference rejection and fresh observation/click.
  Result: 1 passed with Chrome enabled.
- `cargo clippy --manifest-path bud/Cargo.toml --lib -- -D warnings`: passed.
- `git diff --check`: passed.
- Earlier broader `cargo test --manifest-path bud/Cargo.toml --lib browser::`
  passed 62 with 6 ignored. Opt-in live tests without their environment variables
  return early; this count is not a claim of broad Chrome acceptance.
- Confirmed the generated `browser-helper.tar.gz` contains `repl-worker.mjs`.

A synthetic memory check measured approximately 51.2 MiB RSS / 5.3 MiB used heap
for an initialized worker and 70.1 MiB RSS / 12.7 MiB used heap after retaining
20,000 generated nodes (2,346,671 serialized bytes). This supports the initial
128 MiB old-space choice for the bounded snapshot design; it is not a real-agent
benchmark or a total-memory guarantee.

## Next acceptance

Phase 2 exposes selective observations, image/file bounds and the typed facade
through the real agent. Physical mobile and broad viewer acceptance remain in
Phase 3; context comparisons and catalog cutover remain Phase 4.

## Phase 1 service completion validation

`BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/browser/repl.test.ts src/browser/continuation.test.ts src/browser/broker.test.ts`
initially failed with `BrowserError: browser_stopped` (continuation fixture ran
new cases after its deliberately stopped resource), and `actual interrupted,
expected ready` (a pre-send canceled cell was incorrectly marking Chrome unhealthy).
Moved the stop fixture last. Cell completion now preserves prior Chrome health:
local JS success, worker failure and canceled dispatch do not establish whether
Chrome is healthy. Browser recovery remains responsible for that state.

Found a 24 KiB daemon envelope cap inconsistent with 64 KiB cell source; exec alone
now allows a 512 KiB encoded envelope for JSON escaping, retaining the decoded
64 KiB limit. Service validates 32 KiB UTF-8 text / 2 KiB exception output with a
256 KiB serialized receipt envelope. Ordinary browser limits remain unchanged.

Second run of the same command exposed a missing historical `browser_exec` result
in conversation reconstruction (`assert.ok(Array.isArray(blocks))`): the narrow
executable-tool parser dropped it. Added receipt/continuation replay alongside
existing stored-only permission results, without adding an executable catalog
entry. Also fixed the private-control fixture's missing `control_session_id`
(`browser_resource_control_check`); production checks were correct.

Final validation (2026-09-23):

- `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/browser/repl.test.ts src/browser/continuation.test.ts src/browser/repository.test.ts src/browser/broker.test.ts src/browser/transport.test.ts src/agent/conversation-loader.test.ts`: 22 passed, none skipped. Local disposable-schema tests exercise real SQL admission/receipts and durable continuation; authenticated carrier results are simulated, not a real provider run.
- `pnpm --dir service exec tsc --noEmit`: passed.
- `BUD_BROWSER_NODE=<managed-node> BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml --lib repl_execution -- --nocapture`: 14 passed, including enabled real Chrome fixture. Worker crash preserves the clicked page/title; clean takeover preserves bindings and invalidates old references. Separate manager replacement checks heap loss after daemon restart.
- `cargo test --manifest-path bud/Cargo.toml --lib browser_cell_envelope`: 1 passed.
- `cargo clippy --manifest-path bud/Cargo.toml --lib -- -D warnings`: passed.

No schema migration or new browser-facing authorization surface. Service derives
receipt ownership from the admitted invocation and checks it before replay reads
and again before delivery. No live service/daemon restart was performed.

Final review added receipt-only lookup while the daemon is offline: a known
completed cell must not become a false “not executed” result just because no
carrier is currently connected. The same owner/invocation checks apply and a
new offline call cannot consume a dispatch. The 22-test suite and TypeScript
check passed again after this addition.
