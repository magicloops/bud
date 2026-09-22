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
        // Chrome may survive a crashed daemon. Never launch a second process
        // against a live Chrome on this profile; only a provably stale lock is
        // cleared (Phase 3s D2).
        ensure_singleton_free(&path)?;
        seed_appearance(&path)?;
        Ok(Self { path, _lock: lock })
    }

    pub fn ensure_not_running(&self) -> Result<()> {
        ensure_singleton_free(&self.path)
    }

    /// Launch-only cosmetic update under the profile lock. Never called for a
    /// running process, workspace creation, renewal, or Reset acquisition.
    pub fn apply_color(&self, color: Option<&str>) -> Result<()> {
        use std::io::{Read, Write};
        use std::os::unix::fs::OpenOptionsExt;
        let Some(argb) = color.and_then(color_argb) else {
            return Ok(());
        };
        self.ensure_not_running()?;
        let directory = self.path.join("Default");
        if !std::fs::symlink_metadata(&directory)?.is_dir() {
            bail!("browser_profile_preferences_unavailable");
        }
        let path = directory.join("Preferences");
        let mut preferences = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Ok(mut file) => {
                if !file.metadata()?.is_file() {
                    bail!("browser_profile_preferences_unavailable");
                }
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                serde_json::from_slice::<serde_json::Value>(&bytes)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(e) => return Err(e.into()),
        };
        let original = preferences.clone();
        let root = preferences
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("browser_profile_preferences_invalid"))?;
        let browser = root
            .entry("browser")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("browser_profile_preferences_invalid"))?;
        let theme = browser
            .entry("theme")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("browser_profile_preferences_invalid"))?;
        theme.insert("user_color2".into(), serde_json::json!(argb));
        theme
            .entry("color_variant2")
            .or_insert(serde_json::json!(1));
        if preferences == original {
            return Ok(());
        }
        // NamedTempFile is private (0600); rename replaces only after a full flush.
        let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
        staged.write_all(&serde_json::to_vec(&preferences)?)?;
        staged.as_file().sync_all()?;
        staged.persist(&path)?;
        Ok(())
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

/// Chrome's `SingletonLock` is a symlink whose target is `<hostname>-<pid>`.
pub(super) fn singleton_owner(profile: &Path) -> Option<(String, i32)> {
    let target = std::fs::read_link(profile.join("SingletonLock")).ok()?;
    let text = target.to_str()?;
    let (host, pid) = text.rsplit_once('-')?;
    Some((host.to_owned(), pid.parse().ok()?))
}

/// True only when the lock demonstrably belongs to nothing alive on this host:
/// same hostname and either the pid is gone or it is not a process running
/// with this profile's `--user-data-dir`. Anything uncertain is not stale.
pub(super) fn singleton_stale(profile: &Path) -> bool {
    let Some((host, pid)) = singleton_owner(profile) else {
        return false;
    };
    let local = nix::unistd::gethostname()
        .ok()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    if host != local || pid <= 0 {
        return false;
    }
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Err(nix::errno::Errno::ESRCH) => true,
        Err(_) => false,
        Ok(()) => !process_uses_profile(pid, profile),
    }
}

fn process_uses_profile(pid: i32, profile: &Path) -> bool {
    let needle = format!("--user-data-dir={}", profile.display());
    #[cfg(target_os = "linux")]
    let command = std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| String::from_utf8_lossy(&bytes).replace('\0', " "))
        .unwrap_or_default();
    #[cfg(not(target_os = "linux"))]
    let command = std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    command.contains(&needle)
}

fn ensure_singleton_free(profile: &Path) -> Result<()> {
    if std::fs::symlink_metadata(profile.join("SingletonLock")).is_err() {
        return Ok(());
    }
    if singleton_stale(profile) {
        tracing::warn!(
            component = "browser_profile",
            "Removing stale Chrome singleton lock left by an unclean exit"
        );
        clear_singleton_files(profile);
        return Ok(());
    }
    bail!("browser_profile_recovery_required")
}

/// Remove Chrome's singleton files. Only called when ownership is certain:
/// after our own child was killed, or when the lock is provably stale.
pub(super) fn clear_singleton_files(profile: &Path) {
    for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
}

fn color_argb(color: &str) -> Option<i32> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    u32::from_str_radix(&color[1..], 16)
        .ok()
        .map(|rgb| (0xff00_0000 | rgb) as i32)
}

/// Seed only an empty, exclusively owned profile, before Chrome can write it.
/// Name/avatar remain user-owned; the Bud color is refreshed only before launch.
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
pub fn secure_storage_ready() -> Result<()> {
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
pub fn secure_storage_ready() -> Result<()> {
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
        // Foreign host: never ours to judge.
        symlink("other-host-1234", path.join("SingletonLock")).unwrap();
        assert!(Profile::acquire(base.path(), "service", "resource", "alice").is_err());
        std::fs::remove_file(path.join("SingletonLock")).unwrap();
        let host = nix::unistd::gethostname()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // Live process using this profile: refused.
        // A loop keeps the shell (and its argv) alive; `sh -c 'sleep'` would
        // exec straight into sleep and drop the profile argument.
        let mut live = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "while :; do sleep 1; done",
                "sh",
                &format!("--user-data-dir={}", path.display()),
            ])
            .spawn()
            .unwrap();
        symlink(format!("{host}-{}", live.id()), path.join("SingletonLock")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!singleton_stale(&path));
        assert!(Profile::acquire(base.path(), "service", "resource", "alice").is_err());
        live.kill().unwrap();
        live.wait().unwrap();
        // Dead pid (the reaped child): stale, cleared, acquisition proceeds.
        assert!(singleton_stale(&path));
        let profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        assert!(std::fs::symlink_metadata(path.join("SingletonLock")).is_err());
        drop(profile);
        // Live pid that is not a Chrome on this profile (pid reuse): stale.
        symlink(
            format!("{host}-{}", std::process::id()),
            path.join("SingletonLock"),
        )
        .unwrap();
        assert!(singleton_stale(&path));
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
    #[test]
    fn launch_color_preserves_preferences_and_skips_unchanged_writes() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let base = tempfile::tempdir().unwrap();
        let profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        let path = profile.path.join("Default/Preferences");
        let initial = serde_json::json!({"profile":{"name":"Custom","avatar_index":12},
            "extensions":{"theme":{"id":"keep-installed-theme"}},
            "browser":{"theme":{"color_variant2":3,"user_color2":-65281}},
            "session":{"restore_on_startup":1}});
        std::fs::write(&path, serde_json::to_vec(&initial).unwrap()).unwrap();
        profile.apply_color(Some("#123456")).unwrap();
        let mut expected = initial;
        expected["browser"]["theme"]["user_color2"] = serde_json::json!(-15584170);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
            expected
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let inode = std::fs::metadata(&path).unwrap().ino();
        for color in [None, Some("#123456"), Some("bad"), Some("#GGGGGG")] {
            profile.apply_color(color).unwrap();
            assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
        }
        profile.apply_color(Some("#ABCDEF")).unwrap();
        assert_eq!(color_argb("#ABCDEF"), Some(-5517841));
        assert_eq!(color_argb("#000000"), Some(-16777216));
        assert_eq!(color_argb("#FFFFFF"), Some(-1));
    }

    #[test]
    fn launch_color_never_overwrites_unsafe_or_malformed_preferences() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let base = tempfile::tempdir().unwrap();
        let profile = Profile::acquire(base.path(), "service", "resource", "alice").unwrap();
        let path = profile.path.join("Default/Preferences");
        for contents in [
            "not json",
            "[]",
            r#"{"browser":42}"#,
            r#"{"browser":{"theme":null}}"#,
        ] {
            std::fs::write(&path, contents).unwrap();
            assert!(profile.apply_color(Some("#123456")).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), contents);
        }
        std::fs::remove_file(&path).unwrap();
        let outside = base.path().join("outside");
        std::fs::write(&outside, "private").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(profile.apply_color(Some("#123456")).is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "private");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(profile.apply_color(Some("#123456")).is_err());
        std::fs::remove_dir(&path).unwrap();
        profile.apply_color(Some("#123456")).unwrap();
        let before = std::fs::read(&path).unwrap();
        std::fs::set_permissions(
            profile.path.join("Default"),
            std::fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        assert!(profile.apply_color(Some("#FFFFFF")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::set_permissions(
            profile.path.join("Default"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        symlink("host-1234", profile.path.join("SingletonLock")).unwrap();
        assert!(profile.apply_color(Some("#FFFFFF")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_file(profile.path.join("SingletonLock")).unwrap();
        std::fs::rename(
            profile.path.join("Default"),
            profile.path.join("RealDefault"),
        )
        .unwrap();
        symlink(
            profile.path.join("RealDefault"),
            profile.path.join("Default"),
        )
        .unwrap();
        assert!(profile.apply_color(Some("#FFFFFF")).is_err());
    }
}
