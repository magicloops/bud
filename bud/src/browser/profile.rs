//! Persistent profile identity and exclusive ownership. No discovery by PID/port.
use anyhow::{bail, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};

pub(super) struct Profile {
    pub path: PathBuf,
    _lock: File,
}

impl Profile {
    /// `resource` is a service-minted owner/claim-bound identity, never a model argument.
    pub fn acquire(base: &Path, environment: &str, resource: &str, owner: &str) -> Result<Self> {
        use std::os::unix::{
            fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
            io::AsRawFd,
        };
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(environment, resource, owner))?)
        );
        let root = base.join("browser-profiles");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)?;
        let root_metadata = std::fs::symlink_metadata(&root)?;
        if !root_metadata.is_dir() || root_metadata.permissions().mode() & 0o077 != 0 {
            bail!("browser_profile_permissions");
        }
        let path = root.join(key);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .or_else(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    Ok(())
                } else {
                    Err(e)
                }
            })?;
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            bail!("browser_profile_permissions");
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.join("bud.lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("browser_profile_in_use");
        }
        // Chrome may survive a crashed daemon. Never remove its singleton lock
        // or launch a second process against uncertain ownership, even if stale.
        if std::fs::symlink_metadata(path.join("SingletonLock")).is_ok() {
            bail!("browser_profile_recovery_required");
        }
        seed_appearance(&path)?;
        Ok(Self { path, _lock: lock })
    }

    pub fn reset(self) -> Result<()> {
        // Only the caller holding the lifecycle lock may reset, after child exit.
        for entry in std::fs::read_dir(&self.path)? {
            let entry = entry?;
            if entry.file_name() == "bud.lock" {
                continue;
            }
            if entry.file_type()?.is_dir() {
                std::fs::remove_dir_all(entry.path())?;
            } else {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

/// Seed only an empty, exclusively owned profile, before Chrome can write it.
/// Chrome owns these preferences after first launch, including user customization.
fn seed_appearance(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::read_dir(path)?
        .any(|entry| entry.map(|e| e.file_name() != "bud.lock").unwrap_or(true))
    {
        return Ok(());
    }
    let staging = tempfile::Builder::new()
        .prefix(".appearance-")
        .tempdir_in(path)?;
    let preferences = staging.path().join("Preferences");
    std::fs::write(
        &preferences,
        serde_json::to_vec(&serde_json::json!({
            "profile": {
                "name": "Bud Browser",
                "avatar_index": 44,
                "using_default_name": false,
                "using_default_avatar": false
            },
            "browser": { "theme": { "color_variant2": 1, "user_color2": -65281 } }
        }))?,
    )?;
    std::fs::set_permissions(&preferences, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(staging.path(), path.join("Default"))?;
    Ok(())
}

/// Refuse an unavailable native keychain instead of selecting Chrome's basic store.
#[cfg(target_os = "macos")]
pub(super) fn secure_storage_ready() -> Result<()> {
    use std::ffi::c_void;
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainCopyDefault(keychain: *mut *mut c_void) -> i32;
        fn SecKeychainGetStatus(keychain: *mut c_void, status: *mut u32) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }
    let mut keychain = std::ptr::null_mut();
    let mut status = 0;
    unsafe {
        if SecKeychainCopyDefault(&mut keychain) != 0 || keychain.is_null() {
            bail!("browser_secure_storage_unavailable");
        }
        let result = SecKeychainGetStatus(keychain, &mut status);
        CFRelease(keychain);
        // Unlocked, readable and writable. No prompt or secret read in preflight.
        if result != 0 || status & 7 != 7 {
            bail!("browser_secure_storage_locked");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn secure_storage_ready() -> Result<()> {
    // Explicitly unsupported until the pinned Linux distribution's Secret Service
    // failure behavior is validated; never permit an implicit plaintext fallback.
    bail!("browser_secure_storage_unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appearance_is_seeded_once_and_restored_after_reset() {
        let base = tempfile::tempdir().unwrap();
        let profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        let preferences = profile.path.join("Default/Preferences");
        let seeded = std::fs::read(&preferences).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&seeded).unwrap();
        assert_eq!(value["profile"]["name"], "Bud Browser");
        assert_eq!(value["profile"]["avatar_index"], 44);
        assert_eq!(value["browser"]["theme"]["user_color2"], -65281);
        std::fs::write(&preferences, "user customization").unwrap();
        drop(profile);
        let profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        assert_eq!(
            std::fs::read_to_string(&preferences).unwrap(),
            "user customization"
        );
        profile.reset().unwrap();
        let _profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        assert_eq!(std::fs::read(&preferences).unwrap(), seeded);
    }

    #[test]
    fn unsafe_permissions_and_surviving_chrome_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let base = tempfile::tempdir().unwrap();
        let profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        let path = profile.path.clone();
        drop(profile);
        symlink("host-1234", path.join("SingletonLock")).unwrap();
        assert!(Profile::acquire(base.path(), "service", "resource", "alice").is_err());
        std::fs::remove_file(path.join("SingletonLock")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Profile::acquire(base.path(), "service", "resource", "alice").is_err());
    }

    #[test]
    fn ownership_lock_and_profile_survive_reopen() {
        let base = tempfile::tempdir().unwrap();
        let a = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        std::fs::write(a.path.join("persisted"), "fixture").unwrap();
        assert!(Profile::acquire(base.path(), "service", "resource", "alice").is_err());
        let b = Profile::acquire(base.path(), "service", "resource", "bob").unwrap();
        assert_ne!(a.path, b.path);
        drop(a);
        let a = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        assert_eq!(
            std::fs::read_to_string(a.path.join("persisted")).unwrap(),
            "fixture"
        );
        let a_path = a.path.clone();
        a.reset().unwrap();
        assert!(!a_path.join("persisted").exists());
        assert!(!b.path.join("persisted").exists());
    }
}
