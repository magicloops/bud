//! # stem
//!
//! Bud's native terminal session manager — the tmux replacement.
//!
//! Design: `design/native-terminal-session-manager.md` (decisions D1–D15).
//! Plan phase: `plan/native-terminal-session-manager/phase-1-stem-crate.md`.
//!
//! ## Architecture (dumb holder, smart client)
//!
//! A **holder** is a detached process (double-fork + setsid, survival validated by
//! `spikes/holder-survival/`) owning exactly: one PTY, one capped file-backed ring
//! buffer of raw output, and one Unix-domain-socket server speaking the closed
//! ~8-op protocol in [`ipc`]. It parses nothing and upgrades essentially never.
//!
//! All intelligence runs **client-side** (in the Bud daemon): VT emulation
//! ([`emu`], alacritty_terminal), OSC 133 / OSC 7 / alt-screen scanning
//! ([`semantic`]), mode tracking ([`modes`]), and key encoding ([`keys`]).
//! [`session`] composes them over a [`client::HolderClient`] into the public
//! [`Session`] handle emitting typed [`events::Event`]s.
//!
//! Module ownership boundaries (who runs where):
//! - holder process: [`holder`], [`pty`], [`ring`], server half of [`ipc`]
//! - daemon process: [`client`], [`emu`], [`semantic`], [`modes`], [`keys`],
//!   [`session`], [`registry`], [`introspect`]

pub mod client;
pub mod emu;
mod error;
pub mod events;
pub mod holder;
pub mod introspect;
pub mod ipc;
pub mod keys;
pub mod modes;
pub mod pty;
pub mod registry;
pub mod ring;
pub mod semantic;
pub mod session;

pub use error::StemError;
pub use events::Event;
pub use session::Session;
