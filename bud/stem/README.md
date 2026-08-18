# stem

**Persistent PTY session management with typed terminal semantics.**

stem gives a host application terminals that behave the way agents and
remote UIs need them to: sessions that survive the host process being killed
or upgraded, byte-exact output resume after any disconnect, and *typed facts*
instead of screen-scraping — real exit codes per command (OSC 133), mode
classification (shell / TUI / REPL), damage-quiet settling, and cursor-accurate
ANSI screen snapshots.

It is the engine that replaced tmux inside [Bud](../../bud.spec.md), designed
from day one as an embeddable library with no dependency on its host.

```text
your process ──▶ stem::Session ──UDS──▶ holder (your-binary hold, 1/session)
                 │                        ├─ PTY master ⇄ shell / TUI child
                 │                        └─ capped file-backed ring of raw output
                 ├─ VT emulator (grid, damage, scrollback, ANSI serialization)
                 ├─ OSC 133 / OSC 7 / alt-screen / bracketed-paste scanner
                 └─ mode machine + typed Event stream
```

The load-bearing idea is the **dumb holder**: a tiny detached process
(double-fork + `setsid`) that owns only the PTY, a ring buffer, and an
~8-operation versioned IPC socket. It survives your process dying and
essentially never needs to change — all intelligence (emulation, semantics,
policy) lives in *your* process and upgrades whenever you ship.

## What you get

| Capability | How |
|---|---|
| Sessions survive host crash/upgrade | detached holder processes; validated under launchd and systemd (`KillMode=process`) |
| Byte-exact resume | ring offsets are absolute from session start and never reset; attach with `resume_from_offset` and receive exactly the bytes you missed (or an explicit truncation fact) |
| Real exit codes | OSC 133 `A`/`B`/`C`/`D;exit` scanning, chunk-boundary-safe; command byte-ranges included |
| Interactivity detection | alt-screen entry and mid-command bracketed-paste enables surface as events (the signal that a launched command is a TUI, within ~1s) |
| TUI settling | VT emulation (`alacritty_terminal`) with cursor-artifact-filtered damage; `Settled` fires on real quiet, not timers over raw bytes |
| Faithful snapshots | `screen_ansi()` re-serializes the grid as SGR runs + cursor position; feeding it to a fresh terminal reproduces the screen (roundtrip-tested) |
| Mode classification | shell (integrated) / TUI / REPL (injectable prompt registry) / honest `unknown` |
| Input correctness | semantic key names → mode-aware escape sequences (DECCKM etc.); bracketed-paste text delivery |

## Quickstart

Your binary must forward a subcommand to the holder entrypoint **before any
runtime/threads exist** (holders daemonize by forking):

```rust
fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("hold") {
        let rest: Vec<String> = std::env::args().skip(2).collect();
        return stem::holder::main(&rest).map_err(Into::into);
    }
    run_your_app()
}
```

Then create/attach sessions:

```rust
use stem::registry::{HolderLauncher, Registry};
use stem::pty::SpawnSpec;
use stem::session::{Session, SessionConfig};

let registry = Registry::new(base_dir.join("term"))?; // created 0700
let launcher = HolderLauncher {
    program: std::env::current_exe()?,
    args_prefix: vec!["hold".into()],
};
let dir = registry.ensure("sess-1", &launcher, &SpawnSpec {
    shell: "/bin/zsh".into(), args: vec![], cwd: home, env: vec![],
    cols: 120, rows: 40,
}, 8 * 1024 * 1024).await?;

let (mut session, mut events) = Session::attach(SessionConfig {
    session_dir: dir,
    quiet_ms: 300,
    resume_from_offset: last_committed_offset, // 0 on first attach
    scrollback_lines: 5000,
    repl_matcher: Box::new(stem::modes::NoRepl),
}).await?;

session.write_text("cargo test\n").await?;
while let Some(event) = events.recv().await {
    match event {
        stem::Event::Output { offset, bytes } => { /* stream/store, offset-addressed */ }
        stem::Event::CommandFinished { exit_code, .. } => { /* real exit code */ }
        stem::Event::Settled { .. } | stem::Event::PromptReady { .. } => { /* it's quiet */ }
        _ => {}
    }
}
```

`cargo run -p stem --example repl` is an interactive smoke tool.

## Embedder responsibilities

stem deliberately does **not** own these; the host must:

- **Forward the holder subcommand** (above). Single-binary hosts re-exec
  themselves; anything else must ship a holder binary.
- **Supervision directives** when the host runs as a service: holders survive
  process-group kills natively (double-fork/setsid), but **systemd cgroup
  cleanup kills them unless the unit sets `KillMode=process`** (load-bearing;
  validated by a survival matrix — see `spikes/holder-survival/findings.md`
  in the Bud repo). launchd needs nothing; `AbandonProcessGroup=true` is
  cheap insurance.
- **Shell integration** (OSC 133 emitters). stem consumes markers from any
  source; Bud injects zsh/bash shims at spawn (fish emits natively). Without
  markers you get honest `integration: none` and can layer a sentinel
  strategy on top (Bud appends an exit-code trailer to submitted commands).
- **Policy**: REPL prompt registry (`ReplMatcher`), quiet thresholds, ring
  caps, session naming, and anything resembling product behavior.

## Semantics worth knowing (edge cases by design)

- **Holder crash = session lost.** The event stream ends without
  `ChildExited`; callers must treat stream-end as closure. Registry
  `gc_stale()` collects the corpse (only once the pid is truly dead).
- **Ring truncation is loud.** Resuming below the ring's oldest retained
  byte yields an explicit truncation fact before any output — never a
  silent gap. Sizing the ring bounds how long a disconnected consumer can
  stay away (default 8 MiB).
- **Reboot kills sessions** (they're processes). Stale registry dirs are
  detectable (dead pid in `meta.json`) and GC-able.
- **Replay is state-faithful, event-suppressed.** Attach replays retained
  bytes through a fresh emulator for screen fidelity, but only emits
  events/output above your `resume_from_offset` — historical commands don't
  re-fire; mode arrives as one snapshot.
- **Inline TUIs stay `mode: shell`.** Programs that never enter the
  alternate screen (chat TUIs) are classified honestly; use the
  `BracketedPasteChanged`/open-command facts to detect them, and `Settled`
  fires mid-command for exactly this case.
- **IPC is additive-forever.** Holders outlive host upgrades, so the wire
  enum only ever grows; a client must accept holders up to two protocol
  versions behind (`ipc.rs` documents the contract).

## Extraction status: what remains to make this a real standalone package

The crate already enforces host-independence (no `bud` imports; policy
injected). Remaining work, roughly ordered:

1. **Name + registry**: check `stem` availability on crates.io (likely
   contested; candidates: `stem-term`, `budstem`). Reserve early.
2. **License + metadata**: choose (MIT/Apache-2.0 dual is conventional),
   fill `Cargo.toml` metadata, docs.rs config.
3. **Holder distribution story for non-single-binary hosts**: an optional
   `stem-hold` bin target behind a feature flag, so embedders who can't
   re-exec themselves can ship it alongside.
4. **CI**: macOS + Linux test lanes, and the **cross-binary IPC skew job**
   (holder built at previous release vs HEAD client) — the in-process
   version-mismatch tests exist, but the real guarantee needs two binaries.
   This is the biggest gap between "works" and "trustworthy as a dependency".
5. **API polish** (known gaps, tracked in Bud's specs): `Session` doesn't
   expose `integration()` or ring stats (Bud opens an extra stat connection);
   `mark_no_integration()`/`mark_sentinel_integration()` swallow their
   `ModeChange` (callers re-emit); `Resized` only echoes client-initiated
   resizes (holder-side observation would need an additive IPC push);
   holder post-exit TTL is a constant that should be config.
6. **Shell-integration helpers**: the zsh/bash shim generators currently
   live in the Bud daemon; a standalone package should offer them as an
   opt-in module (they're the difference between `osc133` and `none` for
   most users). Known issue to fix first: verify bash 3.2 emits markers
   after SIGINT under the `--rcfile` shim.
7. **Platform matrix honesty**: macOS + Linux are tested; BSDs are
   untested-but-plausible; Windows needs a ConPTY holder (the
   `portable-pty` door was deliberately left open) and a different
   persistence story — document as unsupported until then.
8. **Semver policy doc**: the IPC additive-only rule must be written into
   the release process, not just module docs — it is the one place where a
   careless minor bump breaks running production sessions.
9. **Fuzzing the scanner/ring**: the OSC scanner is hostile-input-capped and
   the ring resets on corruption, but a fuzz target for both would be cheap
   confidence for a public package.

## Provenance

Extracted from Bud's tmux replacement project. Design decisions (D1–D15),
the holder survival matrix, and the emulator bake-off live in the Bud repo:
`design/native-terminal-session-manager.md`, `spikes/holder-survival/`,
`spikes/emulator-bakeoff/`.
