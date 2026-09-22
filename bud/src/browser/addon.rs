//! Browser support as an opt-in add-on (design/browser-addon.md, Phase 3r).
//!
//! `bud browser prepare` writes `<base_dir>/browser/manifest.json` describing
//! the browser executable (system Chrome/Chromium preferred, a pinned managed
//! Chrome for Testing as plan B), the managed Node runtime and the helper. The
//! daemon only ever reads that manifest; it never downloads. Environment
//! variables remain explicit development overrides.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

use super::pins;

pub const MANIFEST_SCHEMA: u32 = 1;
const ADDON_DIR: &str = "browser";
const MANIFEST_FILE: &str = "manifest.json";

/// Everything the browser manager needs to launch: browser, Node and helper.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Runtime {
    pub executable: PathBuf,
    pub node: PathBuf,
    pub helper: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub schema: u32,
    pub prepared_at: String,
    pub prepared_by: String,
    pub browser: BrowserRecord,
    pub node: RuntimeRecord,
    pub helper: RuntimeRecord,
    pub probe: ProbeRecord,
    /// Recorded from a source checkout via `--helper-dir`/`--node`; version
    /// staleness checks are skipped.
    #[serde(default)]
    pub dev: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserRecord {
    /// `system` or `managed`.
    pub kind: String,
    /// `chrome`, `chromium`, `chrome-for-testing` or `custom`.
    pub product: String,
    pub path: PathBuf,
    /// `Browser.getVersion` product string observed by the last probe/launch.
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRecord {
    pub path: PathBuf,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeRecord {
    pub ok: bool,
    pub checked_at: String,
    #[serde(default)]
    pub notes: Vec<String>,
}

pub fn addon_dir(base: &Path) -> PathBuf {
    base.join(ADDON_DIR)
}

pub fn manifest_path(base: &Path) -> PathBuf {
    addon_dir(base).join(MANIFEST_FILE)
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn daemon_version() -> String {
    crate::upgrade::current_release_version()
}

pub fn read_manifest(base: &Path) -> Result<Option<Manifest>> {
    let path = manifest_path(base);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("browser_manifest_unreadable"),
    };
    let manifest: Manifest = serde_json::from_str(&text).context("browser_manifest_invalid")?;
    if manifest.schema != MANIFEST_SCHEMA {
        bail!("browser_manifest_schema_unsupported");
    }
    Ok(Some(manifest))
}

/// Atomic write (temp file in the add-on directory, then rename), mode 0600.
pub fn write_manifest(base: &Path, manifest: &Manifest) -> Result<()> {
    let dir = addon_dir(base);
    std::fs::create_dir_all(&dir)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".manifest-")
        .tempfile_in(&dir)?;
    temp.write_all(serde_json::to_string_pretty(manifest)?.as_bytes())?;
    temp.write_all(b"\n")?;
    temp.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o600))?;
    }
    temp.persist(manifest_path(base))
        .map_err(|error| error.error)
        .context("browser_manifest_write_failed")?;
    Ok(())
}

pub fn remove_manifest(base: &Path) -> Result<bool> {
    match std::fs::remove_file(manifest_path(base)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

impl Manifest {
    pub fn runtime(&self) -> Runtime {
        Runtime {
            executable: self.browser.path.clone(),
            node: self.node.path.clone(),
            helper: self.helper.path.clone(),
        }
    }

    /// Reasons this manifest no longer matches the running daemon's pins.
    pub fn stale(&self) -> Vec<String> {
        let mut reasons = Vec::new();
        if self.dev {
            return reasons;
        }
        if self.node.version != pins::NODE_VERSION {
            reasons.push(format!(
                "node {} recorded, daemon pins {}",
                self.node.version,
                pins::NODE_VERSION
            ));
        }
        if self.helper.version != daemon_version() {
            reasons.push(format!(
                "helper {} recorded, daemon is {}",
                self.helper.version,
                daemon_version()
            ));
        }
        // Recorded as a `Browser.getVersion` product string ("Chrome/153.0.8010.12").
        let managed_version = self.browser.version.rsplit('/').next().unwrap_or_default();
        if self.browser.kind == "managed" && managed_version != pins::MANAGED_BROWSER_VERSION {
            reasons.push(format!(
                "managed browser {} recorded, daemon pins {}",
                self.browser.version,
                pins::MANAGED_BROWSER_VERSION
            ));
        }
        reasons
    }
}

/// How the daemon resolved (or failed to resolve) its browser runtime.
#[derive(Debug)]
pub enum Resolution {
    /// `BUD_BROWSER_EXECUTABLE` + `BUD_BROWSER_HELPER` (+ optional `BUD_BROWSER_NODE`).
    EnvOverride(Runtime),
    Manifest(Runtime, Box<Manifest>),
    /// Human-readable reason; the browser capability stays unavailable.
    Unavailable(String),
}

pub fn env_override() -> Option<Result<Runtime>> {
    let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE")?;
    let Some(helper) = std::env::var_os("BUD_BROWSER_HELPER") else {
        return Some(Err(anyhow!(
            "BUD_BROWSER_EXECUTABLE is set without BUD_BROWSER_HELPER; either set both (development override) or unset them and run `bud browser prepare`"
        )));
    };
    Some(Ok(Runtime {
        executable: PathBuf::from(executable),
        node: std::env::var_os("BUD_BROWSER_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node")),
        helper: PathBuf::from(helper),
    }))
}

pub fn resolve(base: &Path) -> Resolution {
    match env_override() {
        Some(Ok(runtime)) => return Resolution::EnvOverride(runtime),
        Some(Err(error)) => return Resolution::Unavailable(error.to_string()),
        None => {}
    }
    resolve_manifest(base)
}

/// Manifest-only resolution (no environment override).
pub fn resolve_manifest(base: &Path) -> Resolution {
    match read_manifest(base) {
        Ok(Some(manifest)) => {
            if !manifest.probe.ok {
                return Resolution::Unavailable(
                    "browser manifest records a failed probe; run `bud browser prepare`".into(),
                );
            }
            Resolution::Manifest(manifest.runtime(), Box::new(manifest))
        }
        Ok(None) => Resolution::Unavailable(
            "browser support is not prepared on this machine; run `bud browser prepare`".into(),
        ),
        Err(error) => Resolution::Unavailable(format!(
            "browser manifest unusable ({error}); run `bud browser prepare`"
        )),
    }
}

/// Best-effort: the daemon records a browser version it observed that differs
/// from the manifest (a system browser auto-updated). Nothing else changes.
pub fn record_observed_version(base: &Path, version: &str) {
    let Ok(Some(mut manifest)) = read_manifest(base) else {
        return;
    };
    if manifest.browser.version == version {
        return;
    }
    tracing::info!(
        component = "browser_addon",
        previous = %manifest.browser.version,
        observed = %version,
        "Browser version changed since prepare; updating manifest"
    );
    manifest.browser.version = version.to_owned();
    manifest.probe.checked_at = now();
    if let Err(error) = write_manifest(base, &manifest) {
        tracing::warn!(reason = %error, "Browser manifest update failed");
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    Chrome,
    Chromium,
    Edge,
    Brave,
}

impl Product {
    pub fn id(self) -> &'static str {
        match self {
            Product::Chrome => "chrome",
            Product::Chromium => "chromium",
            Product::Edge => "edge",
            Product::Brave => "brave",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Product::Chrome => "Google Chrome",
            Product::Chromium => "Chromium",
            Product::Edge => "Microsoft Edge",
            Product::Brave => "Brave",
        }
    }
    /// First cut: Chrome and Chromium only. Edge/Brave are reported, not used.
    pub fn supported(self) -> bool {
        matches!(self, Product::Chrome | Product::Chromium)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub product: Product,
    pub path: PathBuf,
    pub usable: bool,
    pub reason: Option<String>,
}

/// Preference-ordered locations per OS. Existence is checked by the caller.
pub fn system_candidate_paths() -> Vec<(Product, PathBuf)> {
    let mut list = Vec::new();
    if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let apps = |name: &str, binary: &str| {
            PathBuf::from("/Applications")
                .join(name)
                .join("Contents/MacOS")
                .join(binary)
        };
        list.push((Product::Chrome, apps("Google Chrome.app", "Google Chrome")));
        if let Some(home) = &home {
            list.push((
                Product::Chrome,
                home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ));
        }
        list.push((Product::Chromium, apps("Chromium.app", "Chromium")));
        list.push((Product::Edge, apps("Microsoft Edge.app", "Microsoft Edge")));
        list.push((Product::Brave, apps("Brave Browser.app", "Brave Browser")));
    } else {
        for (product, name) in [
            (Product::Chrome, "google-chrome"),
            (Product::Chrome, "google-chrome-stable"),
            (Product::Chromium, "chromium"),
            (Product::Chromium, "chromium-browser"),
            (Product::Edge, "microsoft-edge"),
            (Product::Brave, "brave-browser"),
        ] {
            if let Some(path) = which(name) {
                list.push((product, path));
            }
        }
        list.push((Product::Chrome, PathBuf::from("/opt/google/chrome/chrome")));
    }
    list
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Classify preference-ordered `(product, path)` pairs. `exists` and
/// `canonical` are injected so ordering and exclusion rules are unit-testable.
pub fn classify_candidates(
    paths: &[(Product, PathBuf)],
    exists: impl Fn(&Path) -> bool,
    canonical: impl Fn(&Path) -> PathBuf,
) -> Vec<Candidate> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (product, path) in paths {
        if !exists(path) {
            continue;
        }
        let resolved = canonical(path);
        if !seen.insert(resolved.clone()) {
            continue;
        }
        let (usable, reason) = if !product.supported() {
            (
                false,
                Some(format!("{} is not supported yet", product.label())),
            )
        } else if resolved.starts_with("/snap") || path.starts_with("/snap") {
            (
                false,
                Some(
                    "snap-confined Chromium cannot use a Bud profile directory or the debugging pipe; use `bud browser prepare --managed`"
                        .into(),
                ),
            )
        } else {
            (true, None)
        };
        out.push(Candidate {
            product: *product,
            path: path.clone(),
            usable,
            reason,
        });
    }
    out
}

pub fn detect_system_browsers() -> Vec<Candidate> {
    classify_candidates(
        &system_candidate_paths(),
        |path| path.is_file(),
        |path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
    )
}

/// Major version from a `Browser.getVersion` product string such as
/// `Chrome/153.0.8010.52` or `HeadlessChrome/153.0.8010.12`.
pub fn major_version(product: &str) -> Option<u32> {
    product
        .rsplit('/')
        .next()?
        .split('.')
        .next()?
        .trim()
        .parse()
        .ok()
}

pub fn meets_floor(product: &str) -> bool {
    major_version(product).is_some_and(|major| major >= pins::BROWSER_MIN_MAJOR)
}

// ---------------------------------------------------------------------------
// Downloads and layout
// ---------------------------------------------------------------------------

pub fn artifact_for<'a>(list: &'a [pins::Artifact], target: &str) -> Option<&'a pins::Artifact> {
    list.iter().find(|artifact| artifact.target == target)
}

pub fn node_dir(base: &Path) -> PathBuf {
    addon_dir(base).join("node").join(pins::NODE_VERSION)
}

pub fn helper_dir(base: &Path) -> PathBuf {
    addon_dir(base).join("helper").join(daemon_version())
}

pub fn managed_browser_dir(base: &Path) -> PathBuf {
    addon_dir(base)
        .join("chrome-for-testing")
        .join(pins::MANAGED_BROWSER_VERSION)
}

pub fn downloads_dir(base: &Path) -> PathBuf {
    addon_dir(base).join("downloads")
}

pub fn profiles_dir(base: &Path) -> PathBuf {
    base.join("browser-profiles")
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Stream `url` to `dest`, hashing as it goes. The file only exists at `dest`
/// after the SHA-256 (and size, when pinned) matched; a partial download is
/// removed. Progress is reported through `progress(received, total)`.
pub async fn download_verified(
    url: &str,
    sha256: &str,
    size: u64,
    dest: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    use futures::StreamExt;
    if sha256.is_empty() {
        bail!("pins for {url} carry no checksum; regenerate bud/src/browser/pins.rs");
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = dest.with_extension("partial");
    let result: Result<()> = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20 * 60))
            .build()?;
        let response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("download failed: {url}"))?
            .error_for_status()?;
        let total = response.content_length();
        let mut file = std::fs::File::create(&partial)?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("download interrupted")?;
            hasher.update(&chunk);
            file.write_all(&chunk)?;
            received += chunk.len() as u64;
            progress(received, total);
        }
        file.sync_all()?;
        let actual = hex(hasher.finalize());
        if !actual.eq_ignore_ascii_case(sha256) {
            bail!("checksum mismatch for {url}: expected {sha256}, got {actual}");
        }
        if size != 0 && received != size {
            bail!("size mismatch for {url}: expected {size} bytes, got {received}");
        }
        std::fs::rename(&partial, dest)?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

pub fn extract_tar_gz(archive: &Path, into: &Path) -> Result<()> {
    std::fs::create_dir_all(into)?;
    let file = std::fs::File::open(archive)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    tar.set_preserve_permissions(true);
    tar.unpack(into).context("archive extraction failed")?;
    Ok(())
}

/// App bundles contain symlinks and code signatures; `ditto` preserves both.
#[cfg(target_os = "macos")]
pub fn extract_zip(archive: &Path, into: &Path) -> Result<()> {
    std::fs::create_dir_all(into)?;
    let status = std::process::Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(archive)
        .arg(into)
        .status()
        .context("ditto unavailable")?;
    if !status.success() {
        bail!("zip extraction failed ({status})");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn extract_zip(archive: &Path, into: &Path) -> Result<()> {
    std::fs::create_dir_all(into)?;
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file).context("zip archive unreadable")?;
    zip.extract(into).context("zip extraction failed")?;
    Ok(())
}

/// The helper (sources plus vendored `node_modules`) is packed into the daemon
/// at build time; see build.rs.
const EMBEDDED_HELPER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/browser-helper.tar.gz"));
pub const EMBEDDED_HELPER_COMPLETE: bool = matches!(env!("BUD_HELPER_VENDORED").as_bytes(), b"1");

/// Unpack the embedded helper into `helper/<daemon version>/`. Returns `main.mjs`.
pub fn install_embedded_helper(base: &Path) -> Result<RuntimeRecord> {
    if !EMBEDDED_HELPER_COMPLETE {
        bail!(
            "this daemon build has no vendored browser helper (bud/browser-helper/node_modules was absent at build time); pass --helper-dir <checkout>/bud/browser-helper"
        );
    }
    let dir = helper_dir(base);
    let main = dir.join("main.mjs");
    if !main.is_file()
        || !dir
            .join("node_modules/playwright-core/package.json")
            .is_file()
    {
        let staging = tempfile::Builder::new()
            .prefix(".helper-")
            .tempdir_in(addon_dir(base))?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(EMBEDDED_HELPER));
        tar.unpack(staging.path())
            .context("embedded helper extraction failed")?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(dir.parent().unwrap())?;
        std::fs::rename(staging.keep(), &dir)?;
    }
    Ok(RuntimeRecord {
        path: main,
        version: daemon_version(),
    })
}

/// A checkout's helper directory: must hold `main.mjs` and vendored Playwright.
pub fn helper_from_dir(dir: &Path) -> Result<RuntimeRecord> {
    let main = dir.join("main.mjs");
    if !main.is_file() {
        bail!("{} has no main.mjs", dir.display());
    }
    if !dir
        .join("node_modules/playwright-core/package.json")
        .is_file()
    {
        bail!(
            "{} has no node_modules/playwright-core; run `npm ci --ignore-scripts` there first",
            dir.display()
        );
    }
    Ok(RuntimeRecord {
        path: main,
        version: format!("dev:{}", daemon_version()),
    })
}

pub async fn install_node(
    base: &Path,
    target: &str,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<RuntimeRecord> {
    let artifact = artifact_for(pins::NODE, target)
        .ok_or_else(|| anyhow!("no pinned Node runtime for {target}"))?;
    let dir = node_dir(base);
    let executable = dir.join(artifact.executable);
    if !executable.is_file() {
        let archive = downloads_dir(base).join(
            Path::new(artifact.url)
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("node.tar.gz")),
        );
        download_verified(
            artifact.url,
            artifact.sha256,
            artifact.size,
            &archive,
            progress,
        )
        .await?;
        let staging = tempfile::Builder::new()
            .prefix(".node-")
            .tempdir_in(addon_dir(base))?;
        extract_tar_gz(&archive, staging.path())?;
        let _ = std::fs::remove_file(&archive);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(dir.parent().unwrap())?;
        std::fs::rename(staging.keep(), &dir)?;
        if !executable.is_file() {
            bail!("Node archive did not contain {}", artifact.executable);
        }
    }
    Ok(RuntimeRecord {
        path: executable,
        version: pins::NODE_VERSION.into(),
    })
}

pub async fn install_managed_browser(
    base: &Path,
    target: &str,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<BrowserRecord> {
    let artifact = artifact_for(pins::MANAGED_BROWSER, target)
        .ok_or_else(|| anyhow!("no pinned managed browser for {target}"))?;
    let dir = managed_browser_dir(base);
    let executable = dir.join(artifact.executable);
    if !executable.is_file() {
        let archive = downloads_dir(base).join(
            Path::new(artifact.url)
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("chrome.zip")),
        );
        download_verified(
            artifact.url,
            artifact.sha256,
            artifact.size,
            &archive,
            progress,
        )
        .await?;
        let staging = tempfile::Builder::new()
            .prefix(".chrome-")
            .tempdir_in(addon_dir(base))?;
        extract_zip(&archive, staging.path())?;
        let _ = std::fs::remove_file(&archive);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(dir.parent().unwrap())?;
        std::fs::rename(staging.keep(), &dir)?;
        if !executable.is_file() {
            bail!("browser archive did not contain {}", artifact.executable);
        }
    }
    Ok(BrowserRecord {
        kind: "managed".into(),
        product: "chrome-for-testing".into(),
        path: executable,
        version: String::new(),
    })
}

/// Which managed pieces exist on disk (for `status`/`remove`).
pub fn managed_present(base: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    for (name, dir) in [
        ("node", addon_dir(base).join("node")),
        ("helper", addon_dir(base).join("helper")),
        (
            "managed browser",
            addon_dir(base).join("chrome-for-testing"),
        ),
    ] {
        if dir.exists() {
            out.push((name, dir));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct ProbeOutcome {
    pub version: String,
    pub major: Option<u32>,
    pub notes: Vec<String>,
}

/// Launch through the real adapter (browser, helper and Node all exercised),
/// read the version, close. Fails below the version floor.
pub async fn probe(runtime: &Runtime) -> Result<ProbeOutcome> {
    let mut browser = super::adapter::Browser::launch_probe(runtime)
        .await
        .context("browser probe launch failed")?;
    let version = browser
        .version()
        .await
        .context("browser version unavailable")?;
    browser
        .close()
        .await
        .context("browser probe close failed")?;
    let major = major_version(&version);
    if !meets_floor(&version) {
        bail!(
            "{version} is below the supported floor (Chromium {} , the version playwright-core {} tests against)",
            pins::BROWSER_MIN_MAJOR,
            pins::PLAYWRIGHT_CORE_VERSION
        );
    }
    let mut notes = Vec::new();
    if let Err(error) = super::profile::secure_storage_ready() {
        notes.push(format!(
            "persistent profile unavailable on this host ({error}); the daemon will not advertise the browser until secure storage is validated"
        ));
    }
    Ok(ProbeOutcome {
        version,
        major,
        notes,
    })
}

/// Env-gated live tests: `BUD_BROWSER_EXECUTABLE` plus the checkout's helper
/// (`BUD_BROWSER_HELPER`/`BUD_BROWSER_NODE` override). Test-only; production
/// never resolves the helper from the source tree.
#[cfg(test)]
pub(super) fn test_runtime(executable: impl Into<PathBuf>) -> Runtime {
    Runtime {
        executable: executable.into(),
        node: std::env::var_os("BUD_BROWSER_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node")),
        helper: std::env::var_os("BUD_BROWSER_HELPER")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("browser-helper/main.mjs")
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Manifest {
        Manifest {
            schema: MANIFEST_SCHEMA,
            prepared_at: "2026-09-21T00:00:00Z".into(),
            prepared_by: daemon_version(),
            browser: BrowserRecord {
                kind: "system".into(),
                product: "chrome".into(),
                path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
                version: "Chrome/153.0.8010.52".into(),
            },
            node: RuntimeRecord {
                path: "/tmp/node".into(),
                version: pins::NODE_VERSION.into(),
            },
            helper: RuntimeRecord {
                path: "/tmp/main.mjs".into(),
                version: daemon_version(),
            },
            probe: ProbeRecord {
                ok: true,
                checked_at: "2026-09-21T00:00:00Z".into(),
                notes: vec![],
            },
            dev: false,
        }
    }

    #[test]
    fn manifest_round_trips_atomically_with_private_mode() {
        let base = tempfile::tempdir().unwrap();
        assert!(read_manifest(base.path()).unwrap().is_none());
        let manifest = sample();
        write_manifest(base.path(), &manifest).unwrap();
        assert_eq!(read_manifest(base.path()).unwrap(), Some(manifest.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(manifest_path(base.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(
            std::fs::read_dir(addon_dir(base.path()))
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == MANIFEST_FILE),
            "no temp files left behind"
        );
        assert_eq!(manifest.runtime().executable, manifest.browser.path);
        assert!(remove_manifest(base.path()).unwrap());
        assert!(!remove_manifest(base.path()).unwrap());
    }

    #[test]
    fn corrupt_or_foreign_manifests_are_reported_not_trusted() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(addon_dir(base.path())).unwrap();
        std::fs::write(manifest_path(base.path()), "{not json").unwrap();
        assert!(read_manifest(base.path()).is_err());
        let mut other = serde_json::to_value(sample()).unwrap();
        other["schema"] = serde_json::json!(99);
        std::fs::write(manifest_path(base.path()), other.to_string()).unwrap();
        assert!(read_manifest(base.path()).is_err());
        assert!(matches!(
            resolve_manifest(base.path()),
            Resolution::Unavailable(_)
        ));
    }

    #[test]
    fn staleness_tracks_daemon_pins_but_not_dev_records() {
        let mut manifest = sample();
        assert!(manifest.stale().is_empty());
        manifest.node.version = "v0.0.1".into();
        manifest.helper.version = "v0.0.0".into();
        assert_eq!(manifest.stale().len(), 2);
        manifest.dev = true;
        assert!(manifest.stale().is_empty());
        let mut managed = sample();
        managed.browser.kind = "managed".into();
        managed.browser.version = format!("Chrome/{}", pins::MANAGED_BROWSER_VERSION);
        assert!(
            managed.stale().is_empty(),
            "product string prefix is not drift"
        );
        managed.browser.version = "Chrome/1.0.0.0".into();
        assert_eq!(managed.stale().len(), 1);
    }

    #[test]
    fn failed_probe_manifests_never_resolve_to_a_runtime() {
        let base = tempfile::tempdir().unwrap();
        let mut manifest = sample();
        manifest.probe.ok = false;
        write_manifest(base.path(), &manifest).unwrap();
        assert!(matches!(
            resolve_manifest(base.path()),
            Resolution::Unavailable(_)
        ));
        manifest.probe.ok = true;
        write_manifest(base.path(), &manifest).unwrap();
        assert!(matches!(
            resolve_manifest(base.path()),
            Resolution::Manifest(..)
        ));
    }

    #[test]
    fn observed_version_drift_updates_only_the_version() {
        let base = tempfile::tempdir().unwrap();
        let manifest = sample();
        write_manifest(base.path(), &manifest).unwrap();
        record_observed_version(base.path(), "Chrome/153.0.8010.52");
        assert_eq!(read_manifest(base.path()).unwrap().unwrap(), manifest);
        record_observed_version(base.path(), "Chrome/154.0.8037.0");
        let updated = read_manifest(base.path()).unwrap().unwrap();
        assert_eq!(updated.browser.version, "Chrome/154.0.8037.0");
        assert_eq!(updated.browser.path, manifest.browser.path);
        assert_eq!(updated.node, manifest.node);
    }

    #[test]
    fn candidates_keep_preference_order_and_exclude_snap_edge_and_brave() {
        let paths = vec![
            (
                Product::Edge,
                PathBuf::from("/Applications/Microsoft Edge.app/x"),
            ),
            (Product::Chrome, PathBuf::from("/missing/chrome")),
            (Product::Chromium, PathBuf::from("/usr/bin/chromium")),
            (Product::Chrome, PathBuf::from("/opt/google/chrome/chrome")),
            (Product::Chrome, PathBuf::from("/usr/bin/google-chrome")),
            (Product::Brave, PathBuf::from("/usr/bin/brave-browser")),
        ];
        let classified = classify_candidates(
            &paths,
            |path| !path.starts_with("/missing"),
            |path| {
                if path == Path::new("/usr/bin/chromium") {
                    PathBuf::from("/snap/bin/chromium")
                } else if path == Path::new("/usr/bin/google-chrome") {
                    PathBuf::from("/opt/google/chrome/chrome")
                } else {
                    path.to_path_buf()
                }
            },
        );
        let summary: Vec<_> = classified.iter().map(|c| (c.product, c.usable)).collect();
        assert_eq!(
            summary,
            vec![
                (Product::Edge, false),
                (Product::Chromium, false),
                (Product::Chrome, true),
                (Product::Brave, false),
            ],
            "missing skipped, duplicates collapsed, unsupported reported"
        );
        assert!(classified[1].reason.as_deref().unwrap().contains("snap"));
        assert!(classified[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("not supported"));
        assert_eq!(
            classified.iter().find(|c| c.usable).unwrap().path,
            PathBuf::from("/opt/google/chrome/chrome")
        );
    }

    #[test]
    fn version_floor_parses_product_strings() {
        assert_eq!(major_version("Chrome/153.0.8010.52"), Some(153));
        assert_eq!(major_version("HeadlessChrome/154.0.8037.0"), Some(154));
        assert_eq!(major_version("garbage"), None);
        assert!(meets_floor(&format!(
            "Chrome/{}.0.0.0",
            pins::BROWSER_MIN_MAJOR
        )));
        assert!(!meets_floor(&format!(
            "Chrome/{}.0.0.0",
            pins::BROWSER_MIN_MAJOR - 1
        )));
        assert!(!meets_floor("unknown"));
    }

    #[test]
    fn env_override_requires_the_helper_path() {
        // Serialized by the test runner's single-thread env mutation guard: use
        // unique variable state and restore it.
        let previous: Vec<_> = [
            "BUD_BROWSER_EXECUTABLE",
            "BUD_BROWSER_HELPER",
            "BUD_BROWSER_NODE",
        ]
        .iter()
        .map(|key| (key, std::env::var_os(key)))
        .collect();
        std::env::remove_var("BUD_BROWSER_HELPER");
        std::env::remove_var("BUD_BROWSER_NODE");
        std::env::set_var("BUD_BROWSER_EXECUTABLE", "/tmp/chrome");
        assert!(env_override().unwrap().is_err());
        std::env::set_var("BUD_BROWSER_HELPER", "/tmp/main.mjs");
        let runtime = env_override().unwrap().unwrap();
        assert_eq!(runtime.node, PathBuf::from("node"));
        std::env::remove_var("BUD_BROWSER_EXECUTABLE");
        assert!(env_override().is_none());
        for (key, value) in previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    #[test]
    fn tar_extraction_roundtrip_and_pins_shape() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.gz");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            std::fs::File::create(&archive).unwrap(),
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(5);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "pkg/bin/node", &b"hello"[..])
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        extract_tar_gz(&archive, &dir.path().join("out")).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("out/pkg/bin/node")).unwrap(),
            b"hello"
        );
        for target in [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
        ] {
            assert!(artifact_for(pins::NODE, target).is_some(), "{target}");
            assert!(
                artifact_for(pins::MANAGED_BROWSER, target).is_some(),
                "{target}"
            );
        }
    }
}
