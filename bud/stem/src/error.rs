use std::path::PathBuf;

/// Crate-wide error type. Keep variants coarse and typed where the daemon must
/// branch on them (notably [`StemError::SessionGone`] and version mismatches).
#[derive(Debug, thiserror::Error)]
pub enum StemError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ipc protocol error: {0}")]
    Ipc(String),

    #[error("ipc frame exceeds maximum size ({size} > {max})")]
    FrameTooLarge { size: usize, max: usize },

    #[error("holder speaks ipc v{holder}, client requires v{client}")]
    VersionMismatch { holder: u16, client: u16 },

    #[error("session at {dir} is gone (holder dead or socket missing)")]
    SessionGone { dir: PathBuf },

    #[error("holder reported error: {0}")]
    Holder(String),

    #[error("pty error: {0}")]
    Pty(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, StemError>;
