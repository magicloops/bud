use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tracing_subscriber::{fmt, EnvFilter};
use ulid::Ulid;

type HmacSha256 = Hmac<Sha256>;

pub fn compute_hmac(secret: &str, nonce: &str) -> Result<String> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| anyhow!("invalid device secret length"))?;
    mac.update(nonce.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn new_message_id() -> String {
    Ulid::new().to_string()
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn default_shell() -> &'static str {
    if let Ok(shell) = std::env::var("SHELL") {
        if Path::new(&shell).exists() {
            return Box::leak(shell.into_boxed_str());
        }
    }

    if Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    }
}

pub fn expand_path(path: &str) -> Option<PathBuf> {
    Some(PathBuf::from(shellexpand::tilde(path).into_owned()))
}

pub fn setup_tracing() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(env_filter).with_target(false).init();
}
