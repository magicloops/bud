//! Bud-owned browser runtime. No personal browser attachment.
mod adapter;
pub mod addon;
mod capture;
mod cdp;
mod control;
mod image_bounds;
mod manager;
mod media;
pub mod pins;
mod profile;
mod recovery;
mod repl;
mod semantic;
mod viewer;
pub use addon::Runtime;
pub use manager::{Action, BrowserManager, Reply, Request};
pub use profile::secure_storage_ready;
