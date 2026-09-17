//! Bud-owned browser runtime. No personal browser attachment.
mod adapter;
mod capture;
mod cdp;
mod control;
mod manager;
mod media;
mod profile;
mod recovery;
mod semantic;
mod viewer;
pub use manager::{Action, BrowserManager, Reply, Request};
