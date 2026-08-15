//! Daemon terminal runtime, rebuilt on `stem` (native session manager).
//!
//! The legacy multiplexer backend, `TerminalBackend` trait, capture/delta
//! heuristics, and readiness-confidence machinery are gone. Sessions are
//! persistent holder processes managed through `stem::registry`; all
//! semantics (VT emulation, OSC 133 command lifecycle, mode classification)
//! come from `stem::Session` events, which `session_task` maps onto proto
//! 0.3 wire frames.

mod manager;
mod repl_registry;
mod session_task;
mod shims;

pub use manager::{TerminalConfig, TerminalManager};
