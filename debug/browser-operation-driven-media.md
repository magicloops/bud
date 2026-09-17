# Debug: operation-driven viewer validation

## Environment
Local macOS, Chrome for Testing 152, Rust daemon tests and Node loopback sockets.
Service/daemon changes are opt-in through the daemon capability; web production
code is unchanged. See [Phase 3h](../plan/bud-owned-browser/phase-3h-operation-driven-viewer.md).

## Observed and expected
Previous captures occupied the serial page lock while the agent was idle.
Agent-controlled media should retain its image without repeated captures; private
control should keep continuous demand. Native WebSocket ping/pong separates idle
liveness from image credit without another web protocol or session framework.

## Changes and evidence
- Per-slot watch revision plus relay dirty bit: bounded coalescing, no image cache.
- Idle sizing election now uses liveness/authorization rather than time since ACK.
- Eight live Chrome manager tests passed, including twelve idle seconds while
  holding the page lock, operation refresh and changed/unchanged fit behavior.
- Seven service media/transport tests passed; relay fixture stayed open eleven
  seconds with exactly one capture, then exercised bounded refresh, slow/new viewers,
  in-flight refresh, missing ACK despite pongs, and idle auth/owner revocation.
- Canvas regression passed: thirty simulated idle seconds retain pixels; revoked
  content clears. Service TypeScript build and Rust check passed.

An initial test command was accidentally run from the repository root:
`node --import tsx --test src/browser/media.test.ts src/browser/media-idle.test.ts src/browser/transport.test.ts`.
It reported `Could not find 'src/browser/media.test.ts, src/browser/media-idle.test.ts, src/browser/transport.test.ts'`.
Running the same command from `service/` resolved the working-directory error.

## Remaining manual validation
Restart the user-owned daemon with its usual browser configuration, then browse,
leave the agent idle, take control/scroll/type and return. Confirm the pane updates
at operations and idle logs stop showing repeated captures. Hosted reconnect and
cross-account checks remain in the auth checklist. Temporary capture diagnostics
remain until this measurement is reviewed. No daemon was restarted for the user.
