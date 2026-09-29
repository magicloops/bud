# Debug: macOS background activity attributed to sh

## Environment and reproduction
Installed macOS daemon; System Settings identifies its background activity as `sh`.

## Observed
`launchd_plist` registers `/bin/sh -c` to source `bud.env` before executing Bud.
The job label is already `dev.bud.daemon`; changing the label alone does not remove
shell executable attribution.

## Expected
launchd registers and starts the Bud executable directly, with persisted config
loaded on every start and terminal holders surviving service restarts.

## Proposed fix
- Register `bud service-run <absolute base directory>` directly. This internal,
  pre-Tokio entrypoint parses the existing installer env format as data and execs
  the same binary as the daemon. No shell or process-global environment mutation.
- Preserve env-file precedence over inherited environment, explicit base-directory
  selection, logging, keepalive and `AbandonProcessGroup`.
- Regenerate/reload launchd registration on start/restart; upgrades invoke the
  newly installed binary's service installer rather than old generator code.
- Existing old upgraders cannot gain new post-install logic retroactively. After
  upgrading from such a binary, run `bud service install` once (or `bud restart`
  using the new binary). Re-running the installer also refreshes registration.
- No shell expansions/commands in `bud.env`; supported installer KEY=value quoting
  remains. App bundle branding/SMAppService is separate work.

## Validation
Implemented and validated locally:
- `cargo test --manifest-path bud/Cargo.toml --lib lifecycle::tests`: 9 passed,
  including installer quoting, literal shell-looking values, explicit base-dir,
  missing/unreadable env files, and holder-safe supervision directives.
- `cargo test --manifest-path bud/Cargo.toml --lib upgrade::tests`: 5 passed.
- `cargo build --manifest-path bud/Cargo.toml --bin bud`: passed.
- `cargo clippy --manifest-path bud/Cargo.toml --bin bud -- -D warnings`: passed.
- macOS `plutil -lint -` accepted generated XML with spaces, apostrophes and
  XML-special path characters.
- Real binary `service-run` against a temporary env file confirmed file values
  override inherited env before Clap parsing; missing/extra arguments rejected.
- `git diff --check`: passed.

Actual System Settings display name/cache behavior and live launchd holder
survival require a controlled installed-Mac retest. The developer's running
service was not modified/restarted. After installing the changed binary, run
`bud restart` (or `bud service install`), confirm the plist's first
ProgramArguments entry points to Bud, check background-item attribution, and
verify a terminal session survives another restart.

Specs: `bud/src/src.spec.md`; design: `design/managed-daemon-lifecycle.md`.
