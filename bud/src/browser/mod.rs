//! Bud-owned browser runtime. No personal browser attachment.
mod adapter;
mod cdp;
mod control;
mod manager;
mod media;
mod viewer;
pub use manager::{Action, BrowserManager, Reply, Request};
