# Debug and validation: Phase-2 private browser handoff

## Environment and scope

Local development, building on the uncommitted Phase-1 managed Chrome runtime.
Implementation follows [Phase 2](../plan/bud-owned-browser/phase-2-private-handoff.md).
No production rollout or private-input success is claimed until validated.

## Build observations

- Initial command `cargo test --lib browser::control` ran from the repository
  root and failed: `could not find Cargo.toml in /Users/adam/bud or any parent directory`.
  Corrected working directory to `/Users/adam/bud/bud`.
- Strict serde command validation initially rejected the flattened control
  variant. Changed the wire shape to `{action:"control",control:{operation:...}}`
  and added a regression exercising the exact serialized command.
- Rust media-loop borrow checking required cloning the previous connection
  context before awaiting changes. Web build errors in the initial JSX and auth
  owner key were corrected (`currentUser.user.id` is the actual identity).
- Service build caught the missing takeover directive type import and a stale
  cancellation-registry call signature. Both now use the existing contracts.
- `pnpm db:push` from `service/` proposed unrelated invocation dedupe/constraint
  work, including possible truncation of existing rows. Declined that proposal.
  Ran `pnpm db:generate`, reviewed 0040 (referenced uniqueness before FK) and 0041,
  and applied only those additive SQL files to the local database. No production
  credentials were read or production changes made.

## Authority boundary

Private control must fence new agent operations and delivery of earlier results
before human input is enabled. Keep this authority independent of the serial
CDP lock, so a slow navigation cannot prevent the privacy fence from being set.
Drain acknowledged browser work before enabling human input; uncertain outcomes
remain paused rather than being retried as mutations.

## Implemented recovery details

Private-content visibility persists independently of control state. A paused
private page cannot be watched from another tab or exposed after service restart.
Takeover cannot admit private input while an invocation is still leased/running;
worker claim and acquisition serialize on the thread lock. A stopped invocation
never becomes runnable on Return. A takeover before a provider call resumes with
an explicit observe-again context note, without a fabricated tool call/result.

Return closes the private media socket before its daemon command arrives, so the
daemon preserves only the previous controller's explicit return authority while
paused. It does not allow more input or agent evidence. Stale documents/viewport/
focus reject input; browser busy admission is distinct from unknown execution.
Only known pre-admission media-busy responses and pause fences are retried.

The service and daemon enforce one outstanding frame per capture stream and the
relay enforces independent viewer credit. Frame decode/draw releases ImageBitmap
resources and never writes frames into transcript state. Private text, frame
bodies, tickets and CDP payloads are not application log fields.

## Validation (2026-09-14)

Run package-local commands from their owning directory:

| Command / environment | Result |
| --- | --- |
| `cargo build` in `bud/` | Pass |
| `BUD_BROWSER_EXECUTABLE='<configured CfT executable>' cargo test --lib browser::` | Real Chrome fixtures: authority, isolation, cancel/reconnect, private Unicode/password input, stale frame/focus and media/return |
| `pnpm build` in `service/` | Pass |
| `pnpm build` in `web/` | Pass; existing bundle-size warnings remain |
| `pnpm exec node --import tsx --test src/browser/control.test.ts src/browser/media.test.ts src/browser/transport.test.ts src/agent/browser-tools.test.ts src/agent/invocation-worker.test.ts` in service | 29 pass, one opt-in prototype fixture skipped |
| `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/browser/continuation.test.ts src/browser/repository.test.ts src/browser/control.test.ts src/db/schema-metadata.test.ts` in service | Six pass; isolated schemas, real local PostgreSQL, no live worker fixture collisions |
| `pnpm exec node --experimental-strip-types --test src/features/threads/browser-handoff-state.test.ts src/features/threads/automation-review-projection.test.ts src/features/threads/thread-message-state.test.ts` in web | 22 pass |
| Anonymous `GET http://localhost:3000/api/browser/sessions/browser_01AAAAAAAAAAAAAAAAAAAAAAAA` | 401 with `{"error":"unauthorized"}` |
| `git diff --check` | Pass |

The live daemon tests use installed Chrome for Testing 152 on macOS arm64, with
ephemeral profiles and mock/basic credential storage. They open fixture pages,
not real accounts. The relay test uses real loopback WebSockets: a slow viewer
receives one unacknowledged frame while another continues; ticket replay is
rejected, revoked auth stops delivery, and zero viewers stop capture.

PostgreSQL continuation tests use OpenAI/Anthropic/ds4 ledger labels and canonical
multi-call blocks, not live provider requests. They verify same invocation/turn,
once-only restoration, user takeover with/without a pending tool, and cancel wins.
No claim of full real-provider or hosted-edge acceptance follows from these tests.

## Remaining acceptance and next test

The connected-browser runtime returned `No browser is available` and an empty
browser list during this session. No signed-in browser UI test was possible.
Implementation is ready for that test, but Phase 2 remains unaccepted until it
passes. No iOS viewer was built; it is Phase 3.

1. Use the updated service/web and restart the local daemon with the rebuilt
   binary and configured Chrome for Testing. Confirm `browser.handoff:true` in
   the connected Bud capability. Building alone does not upgrade a running daemon.
2. In ordinary chat, ask the agent to open a supported login or fake-credential
   page and request browser handoff. Open browser must show the same page.
3. Take control, click the input, type/paste through the private viewer, then
   Return to agent. Confirm the same invocation observes the updated page once.
4. Repeat user takeover during work, Stop while waiting, viewer close/reopen,
   second-viewer privacy, service restart, expired control and lost media.
5. Validate two real accounts and sign-out/unclaim/delete while sockets are live;
   verify private content absence from actual transcript/provider/access logs.
6. Measure frame/input latency and memory with simultaneous terminal activity,
   two viewers and a slow client. Validate local HTTPS/ngrok and hosted Cloudflare
   upgrades separately. Local codec/relay tests are not hosted network proof.

Deploy requires migrations 0039–0041 plus the rebuilt daemon for full capability.
An old daemon retains the four semantic tools when supported; an old service never
requests new handoff/media commands. No deployment or commit was performed here.
