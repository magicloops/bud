# Plan: Choose browser window mode during setup

## Context
Users need to sign in through the native Bud Chrome profile without manually
editing daemon environment files. Related spec: [daemon source](../bud/src/src.spec.md).

## Approach
- Offer a macOS headed-mode prompt in `bud browser prepare`, plus mutually
  exclusive `--headed` / `--headless` flags.
- Preserve existing mode by default, including `--yes` and noninteractive runs.
- Without an existing setting, default to headed on macOS and explain that a
  Chrome window makes signing in to accounts easier. Other hosts remain headless.
- Persist the choice in the selected base directory's `bud.env` after the
  browser probe succeeds; reuse the existing restart offer.
- Explain minimized startup and Show browser window. Preserve profile sign-ins.
- Report the configured mode in browser status, separately from the headless probe.
- Reject unsupported explicit headed requests before downloads.

## Validation
- CLI parsing/conflicting flags, unsupported hosts, unattended defaults.
- Round-trip both modes while retaining unrelated settings and collapsing
  duplicate assignments; unreadable configuration must fail without overwrite.
- Focused Rust tests, build, formatting and lint checks.

Completed: browser CLI tests (2), lifecycle tests (9), `cargo build`,
`cargo clippy --lib --bin bud -- -D warnings`, changed-file rustfmt and diff checks.
No installed daemon restart or real profile mutation was performed during validation.

## Rollout
Daemon-only CLI change; upgrade the binary, run `bud browser prepare`, and accept
the restart (or restart later). No DB, protocol, service, web or mobile changes.
Managed launch loads the saved setting; direct foreground runs require the env
variable. Existing browser launch, control and profile behavior is unchanged.
