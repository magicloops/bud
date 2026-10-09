use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use ulid::Ulid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceIdentity {
    pub bud_id: String,
    pub device_secret: String,
    pub server_url: String,
    pub name: String,
    pub default_cwd: String,
}

pub async fn load_identity(path: &Path) -> Result<Option<DeviceIdentity>> {
    match fs::read(path).await {
        Ok(bytes) => {
            let identity = match serde_json::from_slice::<DeviceIdentity>(&bytes) {
                Ok(identity) => identity,
                Err(_) => return Ok(None),
            };

            if identity.bud_id.trim().is_empty() || identity.device_secret.trim().is_empty() {
                return Ok(None);
            }

            Ok(Some(identity))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub async fn persist_identity(path: &Path, identity: &DeviceIdentity) -> Result<()> {
    let serialized = serde_json::to_vec_pretty(identity)?;
    write_private_file(path, &serialized).await
}

pub async fn clear_identity(path: &Path) -> Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub async fn load_or_create_installation_id(path: &Path) -> Result<String> {
    match fs::read_to_string(path).await {
        Ok(value) => {
            let installation_id = value.trim().to_string();
            if installation_id.is_empty() {
                bail!("installation id file is empty");
            }
            Ok(installation_id)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let installation_id = format!("inst_{}", Ulid::new());
            write_private_file(path, installation_id.as_bytes()).await?;
            Ok(installation_id)
        }
        Err(err) => Err(err.into()),
    }
}

pub fn installation_id_path(identity_path: &Path) -> PathBuf {
    match identity_path.parent() {
        Some(parent) => parent.join("installation-id"),
        None => PathBuf::from("installation-id"),
    }
}

async fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let perms = std::fs::Permissions::from_mode(0o600);
        let owned_path = path.to_path_buf();
        tokio::task::spawn_blocking(move || std::fs::set_permissions(owned_path, perms)).await??;
    }

    file.write_all(bytes).await?;
    file.sync_all().await?;
    Ok(())
}

/// Refuse cross-environment reuse before auth failures can clear credentials.
pub async fn validate_server(path: &Path, server: &str) -> Result<()> {
    if let Some(identity) = load_identity(path).await? {
        let origin = |value: &str| -> Result<String> {
            let mut url = url::Url::parse(value)?;
            let scheme = match url.scheme() {
                "ws" => "http",
                "wss" => "https",
                other => other,
            }
            .to_owned();
            url.set_scheme(&scheme)
                .map_err(|_| anyhow::anyhow!("invalid service scheme"))?;
            Ok(url.origin().ascii_serialization())
        };
        if origin(&identity.server_url)? != origin(server)? {
            bail!("stored Bud identity belongs to a different service origin; select a separate --base-dir and claim it (existing identity preserved)");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn origin_mismatch_preserves_identity_and_accepts_http_ws_equivalence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identity.json");
        let identity = DeviceIdentity {
            bud_id: "bud-test".into(),
            device_secret: "secret".into(),
            server_url: "wss://app.bud.dev/ws".into(),
            name: "test".into(),
            default_cwd: "/tmp".into(),
        };
        persist_identity(&path, &identity).await.unwrap();
        let before = fs::read(&path).await.unwrap();
        validate_server(&path, "https://app.bud.dev/")
            .await
            .unwrap();
        assert!(validate_server(&path, "wss://localhost:3443/ws")
            .await
            .is_err());
        assert_eq!(fs::read(&path).await.unwrap(), before);
    }
}
