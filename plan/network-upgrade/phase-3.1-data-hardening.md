# Phase 3.1: HTTP/2 Data Fallback Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented as a small hardening slice before Phase 4

---

## Objective

Tighten the Phase 3 terminal-output data path without expanding scope into file/web-serving streams or QUIC.

This slice keeps `BudControl.Connect` as the lifecycle authority, proves the control-only fallback mode still works, and adds a larger terminal-output smoke so the first data-channel implementation is less brittle before Phase 4 depends on it.

## Scope

### In Scope

- close subordinate `h2_data` trackers and durable transport rows when their owning `h2_grpc` control tracker closes, drains, times out, or is superseded
- record active data tracker frame/byte counters and include them in close logs
- add a local control-fallback smoke where `BudData.Attach` is disabled and terminal output still persists over control
- add a local large-output smoke that verifies output moves over data while terminal input dispatch stays responsive
- document remaining hardening that should wait for file/web-serving work

### Out Of Scope

- authoritative generic stream-credit enforcement for file/web-serving streams
- per-stream fair scheduling
- browser-visible degraded-state APIs
- QUIC data path
- file/web-serving stream implementation

## Implemented Behavior

- `service/src/grpc/control-gateway.ts` finalizes matching `BudData.Attach` sessions before closing a control tracker's durable `device_session` / `transport_session` rows.
- `service/src/grpc/data-gateway.ts` exposes a control-owned finalizer for subordinate data sessions and records terminal-output `framesReceived` / `bytesReceived` counters on active trackers.
- `service/src/scripts/smoke-grpc-data-terminal.ts` supports:
  - default `data` mode
  - `control-fallback` mode with no `BUD_GRPC_DATA_URL`
  - `large-output` mode with a multi-frame terminal-output burst and input dispatch timing

## Validation Commands

```bash
pnpm --dir /Users/adam/bud/service smoke:grpc-data-terminal
pnpm --dir /Users/adam/bud/service smoke:grpc-data-terminal:fallback
pnpm --dir /Users/adam/bud/service smoke:grpc-data-terminal:large
pnpm --dir /Users/adam/bud/service test
pnpm --dir /Users/adam/bud/service lint
pnpm --dir /Users/adam/bud/service exec tsc --project tsconfig.json --noEmit
```

## Deferred Hardening

- tie generic stream-credit grants to actual file/web-serving downstream drain rather than synchronous consumption
- add reset propagation from data stream failures into `bud_stream` state and runtime callers
- expose degraded/fallback state in durable metrics or operator APIs instead of only smoke output and process logs
- add hosted/front-door validation for long-lived data streams

---

*Referenced by: [network-upgrade.spec.md](./network-upgrade.spec.md)*
