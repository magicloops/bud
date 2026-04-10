# Phase 1: Browser Transport Boundary

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Move terminal transport responsibilities out of the thread route and introduce an explicit browser-side boundary that distinguishes:

- human-originated terminal input
- emulator-generated terminal protocol replies
- output writing and bootstrap state rendering

## Why This Phase Comes First

Without a dedicated transport/controller layer, every later phase would keep adding more policy into `web/src/routes/$budId/$threadId.tsx`, which is already overloaded.

This phase should make the thread route stop owning:

- raw xterm outbound wiring
- restore-time transport suppression policy
- low-level input buffering details
- direct assumptions about what `onData(...)` means

## Scope

### Web Controller

Add a dedicated browser-side terminal transport/controller module that owns:

- xterm instance attachment
- outbound-data classification
- write-mode separation:
  - live output
  - bootstrap snapshot
  - restore/reset
- transport-state flags such as:
  - connected
  - restoring
  - bootstrap pending

### xterm Adapter

Add a thin xterm adapter module that recovers the `wasUserInput` distinction from xterm in one isolated place.

Requirements:

- do not spread xterm-internal API assumptions across the route/component tree
- clearly document the xterm version assumption
- add focused tests or narrow debug assertions if practical

### Thread Route Refactor

Update the reference thread route so it:

- delegates xterm outbound integration to the controller
- delegates terminal writes/bootstrap to the controller
- no longer forwards public `term.onData(...)` directly to `/terminal/input`

## Deliverables

- new browser terminal transport/controller module
- new isolated xterm adapter module
- reference thread route refactored to use the controller
- temporary debug logging for classified outbound traffic during development

## Expected Files

- `web/src/routes/$budId/$threadId.tsx`
- new modules under `web/src/lib/` and/or `web/src/components/`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`

## Success Criteria

- [ ] Terminal outbound traffic classification lives outside the thread route.
- [ ] The route no longer directly wires xterm public `onData(...)` to backend terminal input.
- [ ] The browser can identify traffic as `human` vs `emulator_protocol`.
- [ ] The controller exposes explicit write paths for live output vs bootstrap/restore.
- [ ] Restore/bootstrap mode can be expressed explicitly in code instead of inferred from route timing.

## Risks And Notes

- The xterm adapter may need internal API usage. Keep it localized and documented.
- This phase may still keep the existing backend `/terminal/input` path temporarily, but only behind the controller boundary.
- Do not block this phase on the full structured-send route; classification and transport ownership are the first objective.

