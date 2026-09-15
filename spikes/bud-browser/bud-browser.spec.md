# bud-browser

Disposable phase-0 managed Chromium host and authenticated relay experiment for
[Bud-owned browser sessions](../../plan/bud-owned-browser/README.md).

## Files

- `Cargo.toml`, `Cargo.lock`: independent Rust experiment, pinned resolution;
  does not add dependencies to the daemon workspace.
- `relay.mjs`: bounded experimental Fastify relay; real executable imports
  service auth and SQL-scoped ownership. One-use channel-specific host tickets,
  exact browser Origin checks, separate control/media sockets, serial admission,
  finite session lifetime and private viewer identity stamping.
- `agent-bridge.mjs`: explicitly injected five-tool backend for the main-agent
  fixture, with owner/turn/epoch checks, private handoff and fresh-return callbacks.
  Persistence is supplied by the composition; no durable repository lives here.
- `relay.test.mjs`: ownership/Origin/schema checks and a real Rust/Chromium
  control/media/viewer round trip using a fixture authority.
- `viewer.html`, `viewer.css`, `viewer.js`: standalone prototype canvas and
  semantic field controls. No React/SwiftUI or conversation-store frame updates.
- `README.md`: reproducible commands, manual setup and explicit unsupported scope.
- [src/src.spec.md](./src/src.spec.md): Rust browser/control implementation.
- [tests/tests.spec.md](./tests/tests.spec.md): real-browser regression tests.

## Dependencies and limits

Requires installed Chromium and existing service Node dependencies. The
executable uses existing service authentication; tests inject their authority.
No runtime production route or agent tool imports this directory. The optional
AgentService executor interface is exercised by service tests importing the relay.
The spike
deliberately lacks durable state and closes its browser on transport loss.
Productionization must use the plan's lifecycle and privacy contracts instead
of treating these simplifications as supported behavior.

Outstanding gates are tracked in
[phase-0-findings.md](../../plan/bud-owned-browser/phase-0-findings.md).
