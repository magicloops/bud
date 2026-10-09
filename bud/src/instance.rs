//! Local instance boundaries. Locks are daemon-owned, never holder-owned.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// Canonicalize even when the last components have not been created yet.
pub fn canonical_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    match std::fs::canonicalize(&absolute) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = absolute.parent().context("path has no parent")?;
            let parent = canonical_path(parent)?;
            Ok(parent.join(absolute.file_name().context("path has no filename")?))
        }
        Err(error) => Err(error).context("cannot resolve instance path"),
    }
}

pub fn key(base: &Path) -> Result<String> {
    use std::os::unix::ffi::OsStrExt;
    let base = canonical_path(base)?;
    Ok(format!("{:x}", Sha256::digest(base.as_os_str().as_bytes())))
}

pub struct InstanceLock {
    _files: Vec<File>,
    pid_path: PathBuf,
}

impl InstanceLock {
    pub fn acquire(args: &crate::config::BudArgs) -> Result<Self> {
        let paths = args.resolved_paths();
        // Lock all mutable state roots, including advanced identity/terminal
        // overrides, so different bases cannot accidentally share credentials/PTYS.
        let identity_parent = paths
            .identity_file
            .parent()
            .context("identity has no parent")?;
        let mut roots = vec![
            canonical_path(&paths.base_dir)?,
            canonical_path(&paths.identity_file)?
                .parent()
                .unwrap_or(identity_parent)
                .to_owned(),
            canonical_path(&paths.terminal_base_dir)?,
        ];
        roots.sort();
        roots.dedup();
        let base = canonical_path(&paths.base_dir)?;
        let mut files = Vec::new();
        for root in roots {
            std::fs::create_dir_all(&root)?;
            let path = root.join("daemon.lock");
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)?;
            // Nonblocking; flock releases on process exit. File descriptors are
            // close-on-exec, so detached terminal holders never retain this lock.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                bail!("Bud state is already in use at {}; select a separate base, identity and terminal directory", root.display());
            }
            files.push(file);
        }
        let record = serde_json::to_vec(&serde_json::json!({
            "pid": std::process::id(), "base": base,
            "managed": std::env::var("BUD_MANAGED_LAUNCH").as_deref() == Ok("1")
        }))?;
        // Stamp every locked inode with its actual owner, including roots shared
        // through advanced overrides. A stale PID from an earlier owner cannot
        // authorize signaling a process in a different instance.
        for file in &mut files {
            file.set_len(0)?;
            file.write_all(&record)?;
        }
        let pid_path = base.join("bud.pid");
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&pid_path)?
            .write_all(std::process::id().to_string().as_bytes())?;
        Ok(Self {
            _files: files,
            pid_path,
        })
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.pid_path).ok().as_deref()
            == Some(&std::process::id().to_string())
        {
            let _ = std::fs::remove_file(&self.pid_path);
        }
    }
}

pub fn running_pid(base: &Path) -> Option<u32> {
    let path = base.join("daemon.lock");
    let file = OpenOptions::new().read(true).write(true).open(&path).ok()?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0 {
        return None;
    }
    if std::io::Error::last_os_error().kind() != std::io::ErrorKind::WouldBlock {
        return None;
    }
    let record: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if record["base"].as_str()? != canonical_path(base).ok()?.to_str()? {
        return None;
    }
    let pid = u32::try_from(record["pid"].as_u64()?).ok()?;
    if pid <= 1 || pid > i32::MAX as u32 {
        return None;
    }
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).ok()?;
    Some(pid)
}

pub fn managed_running(base: &Path) -> bool {
    running_pid(base).is_some()
        && std::fs::read(base.join("daemon.lock"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|record| record["managed"] == true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn aliases_and_shared_state_cannot_run_twice_but_independent_bases_can() {
        let dir = tempfile::tempdir().unwrap();
        let make = |base: &Path| {
            crate::config::BudArgs::parse_from([
                "bud",
                "--base-dir",
                base.to_str().unwrap(),
                "--identity-file",
                base.join("identity.json").to_str().unwrap(),
                "--terminal-base-dir",
                base.to_str().unwrap(),
            ])
        };
        let a = make(&dir.path().join("a"));
        let first = InstanceLock::acquire(&a).unwrap();
        assert_eq!(
            running_pid(&a.resolved_paths().base_dir),
            Some(std::process::id())
        );
        assert!(InstanceLock::acquire(&a).is_err());
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&a.resolved_paths().base_dir, &alias).unwrap();
        assert!(InstanceLock::acquire(&make(&alias)).is_err());
        let b = make(&dir.path().join("b"));
        let second = InstanceLock::acquire(&b).unwrap();
        let mut shared = make(&dir.path().join("c"));
        shared.identity_file = a.identity_file.clone();
        assert!(InstanceLock::acquire(&shared).is_err());
        drop(first);
        assert_eq!(running_pid(&a.resolved_paths().base_dir), None);
        assert!(InstanceLock::acquire(&a).is_ok());
        drop(second);
    }
}
