# spikes

Experimental implementation spikes that validate architectural choices before they are folded into the production Bud daemon or service.

## Purpose

This folder keeps risky or comparison-oriented work isolated from production packages. Spikes should be reproducible, documented, and tied back to a plan or review document that explains the decision they support.

## Subfolders

- [grpc-interop/](./grpc-interop/grpc-interop.spec.md) - Phase 1.5 network-upgrade harness for validating Rust `tonic` interoperability against Node Connect native gRPC over HTTP/2 and a `@grpc/grpc-js` comparison server.
- [holder-survival/](./holder-survival/holder-survival.spec.md) - Phase 0 harness for the `stem` tmux replacement: detached PTY-holder process (double-fork/setsid, UDS line protocol, ring log), launchd/systemd template variants, and operator-run survival matrix scripts. Concluded 2026-08-15: GO on both platforms — macOS unconditional, Linux requires `KillMode=process` (see `findings.md` for the binding supervision recipe).
- [emulator-bakeoff/](./emulator-bakeoff/emulator-bakeoff.spec.md) - Phase 0 comparison of `wezterm-term` vs `alacritty_terminal` over a recorded/synthetic fixture corpus (grid fidelity, damage APIs for DamageQuiet, OSC 133 observability, throughput, packaging). Concluded: `alacritty_terminal` selected (design D5).

## Dependencies

- [../plan/network-upgrade/phase-1.5-grpc-stack-interop-validation.md](../plan/network-upgrade/phase-1.5-grpc-stack-interop-validation.md) - owning plan phase for the current gRPC interop spike.
- [../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md](../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md) - owning plan phase for the holder-survival and emulator-bakeoff spikes.
- [../design/native-terminal-session-manager.md](../design/native-terminal-session-manager.md) - design decisions (D2/D3/D5) these spikes validate.
- [../bud.spec.md](../bud.spec.md) - root architecture spec and documentation catalog.

## TODOs / Technical Debt

None.

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
