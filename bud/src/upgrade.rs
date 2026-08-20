//! `bud upgrade` — self-update from the get.bud.dev stable manifest
//! (design/managed-daemon-lifecycle.md Option E / phase 2).
//!
//! Mechanics mirror the installer, hardened by its live findings: the
//! archive checksum is verified before anything touches disk state, and the
//! binary is staged next to the destination and RENAMED over it — replacing
//! a running binary in place fails on Linux with ETXTBSY, while rename
//! swaps the directory entry and leaves the executing inode untouched. The
//! running daemon keeps the old inode until the post-upgrade restart.
//!
//! "Update available" means the stable manifest version DIFFERS from ours —
//! not "is newer". The manifest is the authority on what stable is; a
//! promoted rollback must be applied just like a promotion forward.

use std::io::Read;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::lifecycle::{self, LifecyclePaths};
use crate::version;

const DEFAULT_BASE_URL: &str = "https://get.bud.dev";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
/// Best-effort probe budget for the `bud status` line.
pub const STATUS_CHECK_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseManifest {
    pub version: String,
    #[serde(default)]
    pub channel: Option<String>,
    pub artifacts: Vec<ReleaseArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseArtifact {
    pub target: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

pub fn manifest_base_url() -> String {
    std::env::var("BUD_UPGRADE_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

fn manifest_url() -> String {
    format!(
        "{}/releases/stable/manifest.json",
        manifest_base_url().trim_end_matches('/')
    )
}

/// Normalized (leading-`v`) release version of the running binary.
pub fn current_release_version() -> String {
    normalize_version(version::release_version())
}

pub fn normalize_version(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('v') {
        trimmed.to_string()
    } else {
        format!("v{trimmed}")
    }
}

pub fn update_available(current: &str, manifest_version: &str) -> bool {
    normalize_version(current) != normalize_version(manifest_version)
}

/// The release target triple: baked at release build time, with a runtime
/// os/arch mapping fallback for dev builds.
pub fn runtime_target() -> Result<String> {
    let baked = version::build_target();
    if baked != "unknown" {
        return Ok(baked.to_string());
    }
    target_for(std::env::consts::OS, std::env::consts::ARCH)
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!(
                "unsupported platform for upgrade: {}/{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })
}

pub fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<()> {
    let actual = hex::encode(Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        bail!("checksum mismatch: expected {expected}, got {actual}");
    }
    Ok(())
}

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Pull the `bud` binary out of a release `.tar.gz`.
pub fn extract_binary_from_archive(bytes: &[u8]) -> Result<Vec<u8>> {
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().context("read release archive")? {
        let mut entry = entry.context("read archive entry")?;
        let path = entry.path().context("archive entry path")?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if name == "bud" {
            let mut binary = Vec::new();
            entry
                .read_to_end(&mut binary)
                .context("extract bud binary")?;
            if binary.is_empty() {
                bail!("release archive contained an empty bud binary");
            }
            return Ok(binary);
        }
    }
    bail!("release archive did not contain a bud binary");
}

/// ETXTBSY-safe install: stage next to the destination, chmod, rename.
pub fn install_binary(paths: &LifecyclePaths, binary: &[u8]) -> Result<()> {
    let dest = &paths.binary;
    let parent = dest
        .parent()
        .ok_or_else(|| anyhow!("binary path {} has no parent", dest.display()))?;
    std::fs::create_dir_all(parent)?;
    let staged = parent.join(format!(".bud.upgrade.{}", std::process::id()));
    std::fs::write(&staged, binary)
        .with_context(|| format!("cannot write {}", staged.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&staged, dest)
        .with_context(|| format!("cannot install to {}", dest.display()))?;
    Ok(())
}

pub async fn fetch_manifest(timeout: Duration) -> Result<ReleaseManifest> {
    let client = reqwest::Client::builder().timeout(timeout).build()?;
    let manifest = client
        .get(manifest_url())
        .send()
        .await
        .with_context(|| format!("cannot reach {}", manifest_url()))?
        .error_for_status()?
        .json::<ReleaseManifest>()
        .await
        .context("cannot parse release manifest")?;
    Ok(manifest)
}

pub async fn run_upgrade(paths: &LifecyclePaths, check_only: bool) -> Result<()> {
    let manifest = fetch_manifest(MANIFEST_TIMEOUT).await?;
    let current = current_release_version();
    let stable = normalize_version(&manifest.version);

    if !update_available(&current, &stable) {
        println!("Bud is up to date ({current}).");
        return Ok(());
    }
    println!("Update available: {current} -> {stable}");
    if check_only {
        println!("Apply it with: bud upgrade");
        return Ok(());
    }

    let target = runtime_target()?;
    let artifact = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.target == target)
        .ok_or_else(|| anyhow!("stable manifest has no artifact for {target}"))?;

    println!("Downloading {} ...", artifact.url);
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()?;
    let bytes = client
        .get(&artifact.url)
        .send()
        .await
        .with_context(|| format!("download failed: {}", artifact.url))?
        .error_for_status()?
        .bytes()
        .await
        .context("download interrupted")?;
    println!("Verifying checksum ...");
    verify_sha256(&bytes, &artifact.sha256)?;
    let binary = extract_binary_from_archive(&bytes)?;
    install_binary(paths, &binary)?;
    println!("Installed {stable} to {}.", paths.binary.display());

    // The running daemon still executes the OLD inode until restarted.
    if paths.service_installed(lifecycle::ServiceManager::detect()) {
        println!("Restarting the Bud service ...");
        lifecycle::restart(paths)?;
    } else if lifecycle::daemon_running(paths) {
        println!("Restarting the Bud daemon ...");
        lifecycle::restart(paths)?;
    } else {
        println!("Daemon is not running; start it with: bud start");
    }
    println!("Terminal sessions keep running across the restart; they reattach automatically.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_difference_is_the_update_signal_in_both_directions() {
        assert!(!update_available("v0.1.6", "v0.1.6"));
        assert!(!update_available("0.1.6", "v0.1.6"), "normalization");
        assert!(update_available("v0.1.5", "v0.1.6"), "forward");
        // A promoted ROLLBACK is also an update: the manifest is the
        // authority on what stable is.
        assert!(update_available("v0.1.6", "v0.1.5"), "rollback");
    }

    #[test]
    fn target_mapping_covers_the_release_matrix() {
        assert_eq!(target_for("macos", "aarch64"), Some("aarch64-apple-darwin"));
        assert_eq!(target_for("macos", "x86_64"), Some("x86_64-apple-darwin"));
        assert_eq!(
            target_for("linux", "x86_64"),
            Some("x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            target_for("linux", "aarch64"),
            Some("aarch64-unknown-linux-gnu")
        );
        assert_eq!(target_for("linux", "riscv64"), None);
    }

    #[test]
    fn manifest_parses_the_live_get_bud_dev_shape() {
        // Verbatim (truncated) from the promoted v0.1.6 stable manifest.
        let manifest: ReleaseManifest = serde_json::from_str(
            r#"{
                "version": "v0.1.6",
                "channel": "stable",
                "published_at": "2026-08-20T21:53:43Z",
                "artifacts": [
                    {
                        "target": "aarch64-unknown-linux-gnu",
                        "url": "https://get.bud.dev/releases/v0.1.6/bud-aarch64-unknown-linux-gnu.tar.gz",
                        "sha256": "72fe039627cd032a041192a4a3fa2b95f33ca1dbc17f0eccef5db1358daf9fcc",
                        "min_os": "glibc 2.35",
                        "size": 5750629
                    }
                ]
            }"#,
        )
        .expect("manifest parses");
        assert_eq!(manifest.version, "v0.1.6");
        assert_eq!(manifest.artifacts.len(), 1);
        assert_eq!(manifest.artifacts[0].target, "aarch64-unknown-linux-gnu");
    }

    fn build_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        for (name, content) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, name, *content).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn archive_verification_and_extraction_roundtrip() {
        let archive = build_archive(&[("./bud", b"#!/bin/sh\necho new-binary\n")]);
        let sha = hex::encode(Sha256::digest(&archive));
        verify_sha256(&archive, &sha).expect("correct checksum accepted");
        verify_sha256(&archive, &sha.to_uppercase()).expect("case-insensitive");
        assert!(
            verify_sha256(&archive, &"0".repeat(64)).is_err(),
            "wrong checksum rejected"
        );

        let binary = extract_binary_from_archive(&archive).expect("binary extracted");
        assert_eq!(binary, b"#!/bin/sh\necho new-binary\n");

        let no_bud = build_archive(&[("./README", b"nope")]);
        assert!(
            extract_binary_from_archive(&no_bud).is_err(),
            "missing binary rejected"
        );
    }
}
