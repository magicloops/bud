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
                version: 2,
                workspaces: BTreeMap::new(),
            },
            writable: true,
        };
        if let Some(path) = &store.path {
            match read(path) {
                Ok(Some(manifest)) if manifest.version == 1 => {
                    // Old hints were not disclosure-classified. Keep private evidence,
                    // never import it into the agent-visible checkpoint.
                    let backup = path.with_file_name("bud-pages.v1.backup.json");
                    let migrated = std::fs::hard_link(path, &backup)
                        .and_then(|_| std::fs::remove_file(path))
                        .and_then(|_| std::fs::File::open(path.parent().unwrap())?.sync_all());
                    if migrated.is_err() {
                        store.writable = false;
                        tracing::warn!("Browser recovery checkpoint migration unavailable");
                    }
                }
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
    pub fn available(&self) -> bool {
        self.writable
    }

    /// Close-time hint removal is best-effort: a corrupt hints file must not
    /// make a workspace impossible to close. `save` keeps failing closed so a
    /// corrupt file is never overwritten with new authority.
    pub fn forget(&mut self, workspace: &str) -> Result<()> {
        if !self.writable {
            tracing::warn!(
                component = "browser_recovery",
                workspace = %workspace,
                "Recovery hints unavailable; closing without removing hints"
            );
            return Ok(());
        }
        self.save(workspace, None)
    }

    pub fn get(&self, workspace: &str) -> Option<Pages> {
        self.manifest.workspaces.get(workspace).cloned()
    }
    pub fn save(&mut self, workspace: &str, pages: Option<Pages>) -> Result<()> {
        self.save_batch(vec![(workspace.to_owned(), pages)])
    }

    /// Disclosure boundaries commit every workspace together or retain all old hints.
    pub fn save_batch(&mut self, changes: Vec<(String, Option<Pages>)>) -> Result<()> {
        if !self.writable {
            bail!("browser_recovery_unavailable");
        }
        let mut next = self.manifest.workspaces.clone();
        for (workspace, pages) in changes {
            if workspace.is_empty() || workspace.len() > 128 {
                bail!("browser_invalid_workspace");
            }
            if let Some(pages) = pages {
                if !valid_pages(&pages) {
                    bail!("browser_recovery_unavailable");
                }
                next.insert(workspace, pages);
            } else {
                next.remove(&workspace);
            }
        }
        if next == self.manifest.workspaces {
            return Ok(());
        }
        let previous = std::mem::replace(&mut self.manifest.workspaces, next);
        if let Err(error) = self.persist() {
            self.manifest.workspaces = previous;
            return Err(error);
        }
        Ok(())
    }
    fn persist(&self) -> Result<()> {
        let bytes = serde_json::to_vec(&self.manifest)?;
        if bytes.len() as u64 > MAX_BYTES {
            bail!("browser_recovery_limit");
        }
        let Some(path) = &self.path else {
            return Ok(());
        };
        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(path)?;
        std::fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    }
}

/// Saving and automatically loading an address are separate policies.
pub(super) fn storable(url: &str) -> bool {
    url.len() <= 8192
        && url::Url::parse(url).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.username().is_empty()
                && u.password().is_none()
        })
}
pub(super) fn eligible(url: &str) -> bool {
    storable(url)
        && url::Url::parse(url).is_ok_and(|u| {
            !u.path()
                .to_ascii_lowercase()
                .split('/')
                .any(|p| matches!(p, "callback" | "oauth" | "authorize" | "logout" | "signout"))
        })
}
fn valid_pages(p: &Pages) -> bool {
    !p.urls.is_empty()
        && p.urls.len() <= 16
        && p.selected < p.urls.len()
        // Empty is an explicit unavailable-address marker. Preserve its selected
        // position rather than silently presenting an older or different page.
        && p.urls.iter().all(|u| u.is_empty() || storable(u))
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
    if !matches!(manifest.version, 1 | 2)
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
    fn checkpoints_allow_many_threads_but_keep_the_total_byte_bound() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Recovery::load(Some(dir.path()));
        for index in 0..40 {
            store
                .save(
                    &format!("thread-{index}"),
                    Some(Pages {
                        urls: vec![format!("https://example.test/{index}?q=kept#fragment")],
                        selected: 0,
                    }),
                )
                .unwrap();
        }
        assert!(Recovery::load(Some(dir.path())).get("thread-39").is_some());
        let before = std::fs::read(dir.path().join("bud-pages.json")).unwrap();
        let changes = (0..40)
            .map(|index| {
                (
                    format!("large-{index}"),
                    Some(Pages {
                        urls: vec![format!("https://example.test/{}", "x".repeat(8000))],
                        selected: 0,
                    }),
                )
            })
            .collect();
        assert!(store.save_batch(changes).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("bud-pages.json")).unwrap(),
            before
        );
        assert!(store.get("large-0").is_none());
    }

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
        assert!(!store.available());
        assert!(store.save("a", None).is_err());
        // Close must still succeed and must not touch the corrupt evidence.
        store.forget("a").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::remove_file(&path).unwrap();
        symlink("missing", &path).unwrap();
        assert!(Recovery::load(Some(dir.path())).save("a", None).is_err());
    }
    #[test]
    fn full_urls_round_trip_without_normalization() {
        let dir = tempfile::tempdir().unwrap();
        let url = "https://example.com/search?q=a%2Fb&q=c+#/route?x=1";
        let mut store = Recovery::load(Some(dir.path()));
        store
            .save(
                "a",
                Some(Pages {
                    urls: vec![
                        url.into(),
                        "https://example.com/oauth/callback?code=abc#done".into(),
                    ],
                    selected: 1,
                }),
            )
            .unwrap();
        let saved = Recovery::load(Some(dir.path())).get("a").unwrap();
        assert_eq!(saved.urls[0], url);
        assert!(eligible(&saved.urls[0]));
        assert!(!eligible(&saved.urls[1]));
        assert!(storable(&saved.urls[1]));
    }

    #[test]
    fn disclosure_batch_failure_preserves_every_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Recovery::load(Some(dir.path()));
        let pages = Pages {
            urls: vec!["https://example.test/shared".into()],
            selected: 0,
        };
        store.save("a", Some(pages.clone())).unwrap();
        store.save("b", Some(pages.clone())).unwrap();
        let before = std::fs::read(dir.path().join("bud-pages.json")).unwrap();
        let invalid = Pages {
            urls: vec!["https://example.test/".into(); 17],
            selected: 0,
        };
        assert!(store
            .save_batch(vec![
                (
                    "a".into(),
                    Some(Pages {
                        urls: vec!["https://example.test/disclosed".into()],
                        selected: 0
                    })
                ),
                ("b".into(), Some(invalid))
            ])
            .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("bud-pages.json")).unwrap(),
            before
        );
        assert_eq!(store.get("a").unwrap().urls, pages.urls);
    }

    #[test]
    fn migration_preserves_unclassified_hints_without_importing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bud-pages.json");
        let old = br#"{"version":1,"workspaces":{"a":{"urls":["https://example.com/private"],"selected":0}}}"#;
        std::fs::write(&path, old).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut store = Recovery::load(Some(dir.path()));
        assert!(store.available());
        assert!(store.get("a").is_none());
        assert_eq!(
            std::fs::read(dir.path().join("bud-pages.v1.backup.json")).unwrap(),
            old
        );
        store
            .save(
                "b",
                Some(Pages {
                    urls: vec!["https://example.com/public".into()],
                    selected: 0,
                }),
            )
            .unwrap();
        assert!(Recovery::load(Some(dir.path())).get("a").is_none());
    }

    #[test]
    fn excludes_sensitive_or_unsupported_urls_and_bounds_entries() {
        for url in [
            "file:///tmp/a",
            "about:blank",
            "https://u:p@example.com/",
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
