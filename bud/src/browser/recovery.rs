//! Bounded URL hints, not browser authority or a serialized browsing session.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 256 * 1024;
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pages {
    pub urls: Vec<String>,
    pub selected: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    workspaces: BTreeMap<String, Pages>,
}
pub(super) struct Recovery {
    path: Option<PathBuf>,
    manifest: Manifest,
    writable: bool,
}

impl Recovery {
    pub fn load(profile: Option<&Path>) -> Self {
        let path = profile.map(|p| p.join("bud-pages.json"));
        let mut store = Self {
            path,
            manifest: Manifest {
                version: 1,
                workspaces: BTreeMap::new(),
            },
            writable: true,
        };
        if let Some(path) = &store.path {
            match read(path) {
                Ok(Some(manifest)) => store.manifest = manifest,
                Ok(None) => {}
                Err(_) => {
                    // Preserve corrupt evidence; never treat it as authority or overwrite it.
                    store.writable = false;
                    tracing::warn!("Browser page recovery hints unavailable; profile preserved");
                }
            }
        }
        store
    }
    pub fn get(&self, workspace: &str) -> Option<Pages> {
        self.manifest.workspaces.get(workspace).cloned()
    }
    pub fn save(&mut self, workspace: &str, pages: Option<Pages>) -> Result<()> {
        if !self.writable {
            bail!("browser_recovery_unavailable");
        }
        if workspace.is_empty() || workspace.len() > 128 {
            bail!("browser_invalid_workspace");
        }
        if self.manifest.workspaces.get(workspace) == pages.as_ref() {
            return Ok(());
        }
        let previous = self.manifest.workspaces.clone();
        if let Some(pages) = pages {
            if !valid_pages(&pages) {
                bail!("browser_recovery_unavailable");
            }
            if !self.manifest.workspaces.contains_key(workspace)
                && self.manifest.workspaces.len() >= 32
            {
                bail!("browser_recovery_limit");
            }
            self.manifest.workspaces.insert(workspace.to_owned(), pages);
        } else {
            self.manifest.workspaces.remove(workspace);
        }
        if let Err(error) = self.persist() {
            self.manifest.workspaces = previous;
            return Err(error);
        }
        Ok(())
    }
    fn persist(&self) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&self.manifest)?;
        if bytes.len() as u64 > MAX_BYTES {
            bail!("browser_recovery_limit");
        }
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(path)?;
        std::fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    }
}

pub(super) fn eligible(url: &str) -> bool {
    url.len() <= 2048 && url::Url::parse(url).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none()
        // Do not retain query/fragment credentials or common authentication callbacks.
        && u.query().is_none() && u.fragment().is_none()
        && !u.path().to_ascii_lowercase().split('/').any(|p|
            matches!(p, "callback" | "oauth" | "authorize" | "logout" | "signout"))
    })
}
fn valid_pages(p: &Pages) -> bool {
    !p.urls.is_empty()
        && p.urls.len() <= 16
        && p.selected < p.urls.len()
        && p.urls.iter().all(|u| eligible(u))
}
fn read(path: &Path) -> Result<Option<Manifest>> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("browser_recovery_unavailable");
    }
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > MAX_BYTES || meta.permissions().mode() & 0o077 != 0 {
        bail!("browser_recovery_unavailable");
    }
    let mut bytes = Vec::new();
    (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        bail!("browser_recovery_unavailable");
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.version != 1
        || manifest.workspaces.len() > 32
        || manifest
            .workspaces
            .iter()
            .any(|(k, p)| k.is_empty() || k.len() > 128 || !valid_pages(p))
    {
        bail!("browser_recovery_unavailable");
    }
    Ok(Some(manifest))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_urls_remain_workspace_scoped_and_close_removes_hints() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Recovery::load(Some(dir.path()));
        let pages = Pages {
            urls: vec!["https://example.com/".into(); 2],
            selected: 1,
        };
        store.save("a", Some(pages.clone())).unwrap();
        store.save("b", Some(pages.clone())).unwrap();
        drop(store);
        let mut store = Recovery::load(Some(dir.path()));
        assert_eq!(store.get("a").unwrap().selected, 1);
        store.save("a", None).unwrap();
        assert!(Recovery::load(Some(dir.path())).get("a").is_none());
        assert!(store.get("b").is_some());
        assert!(store.get("unknown").is_none());
    }
    #[test]
    fn corrupt_or_symlinked_hints_are_preserved_and_never_loaded() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bud-pages.json");
        std::fs::write(&path, "broken").unwrap();
        let mut store = Recovery::load(Some(dir.path()));
        assert!(store.save("a", None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::remove_file(&path).unwrap();
        symlink("missing", &path).unwrap();
        assert!(Recovery::load(Some(dir.path())).save("a", None).is_err());
    }
    #[test]
    fn excludes_sensitive_or_unsupported_urls_and_bounds_entries() {
        for url in [
            "file:///tmp/a",
            "about:blank",
            "https://u:p@example.com/",
            "https://example.com/?token=a",
            "https://example.com/#secret",
            "https://example.com/oauth/callback",
        ] {
            assert!(!eligible(url));
        }
        let mut store = Recovery::load(None);
        assert!(store
            .save(
                "a",
                Some(Pages {
                    urls: vec!["https://example.com/".into(); 17],
                    selected: 0
                })
            )
            .is_err());
    }
}
