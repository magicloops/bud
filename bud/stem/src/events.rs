//! Typed events emitted by a [`crate::Session`] — the facts the Bud daemon maps
//! onto the proto `0.3` `terminal_event` wire vocabulary (docs/proto.md §6.7.3).
//!
//! stem reports FACTS, not policy: no confidence scores, no readiness guesses.
//! Command identifiers are session-local `u64` indexes; the daemon mints wire
//! ULIDs from them (keeps stem free of clock/id dependencies).

/// How command-lifecycle facts are being obtained for the current shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Integration {
    /// OSC 133 markers observed (shell integration active).
    Osc133,
    /// No markers; the caller is wrapping commands with an exit-code sentinel.
    Sentinel,
    /// No markers detected; command lifecycle is unavailable.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// OSC 133-integrated shell, at prompt or running a command.
    Shell,
    /// Alternate screen active (vim, htop, codex, pagers that use it).
    Tui,
    /// Line-based REPL detected by the injected prompt matcher.
    Repl,
    /// Nothing recognized; caller falls back to heuristics.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Raw output bytes, offset-addressed (absolute from session start).
    /// Forwarded from the holder subscription after local processing.
    Output { offset: u64, bytes: Vec<u8> },

    /// OSC 133 `A` — shell is back at a prompt. `cwd` from OSC 7 when known.
    PromptReady { cwd: Option<String> },

    /// OSC 133 `B`/`C` — a command began. `output_byte_start` is the stream
    /// offset where its output region begins.
    CommandStarted {
        command_index: u64,
        output_byte_start: u64,
    },

    /// OSC 133 `D;<exit>` — the command finished.
    CommandFinished {
        command_index: u64,
        exit_code: Option<i32>,
        output_byte_start: u64,
        output_byte_end: u64,
    },

    /// The session's mode classification changed.
    ModeChanged {
        mode: Mode,
        integration: Integration,
    },

    /// Damage-quiet threshold reached (only emitted in Tui/Repl/Unknown modes;
    /// Shell mode uses command lifecycle instead). `quiet_ms` is the configured
    /// threshold that elapsed, not a measurement.
    Settled { mode: Mode, quiet_ms: u64 },

    /// Current working directory changed (OSC 7, or introspection refresh).
    CwdChanged { cwd: String },

    /// Ring truncation on resume: bytes in `[from_offset, resume_offset)` are lost.
    OutputGap {
        from_offset: u64,
        resume_offset: u64,
    },

    /// The session's root process exited (holder stays up until killed/TTL).
    ChildExited {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },

    /// PTY was resized (echo of a resize request, or holder-side observation).
    Resized { cols: u16, rows: u16 },
}
