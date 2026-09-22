//! `bud browser prepare|status|remove` (design/browser-addon.md, Phase 3r).
//!
//! The CLI is the only writer of the add-on manifest and the only downloader.
//! It prefers an installed Google Chrome/Chromium, installs the pinned managed
//! Chrome for Testing only as plan B, always manages Node and the helper, and
//! finishes by offering the same daemon restart `bud upgrade` uses.

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::json;

use crate::browser::addon::{
    self, BrowserRecord, Candidate, Manifest, ProbeRecord, Runtime, RuntimeRecord,
};
use crate::browser::pins;
use crate::config::{BrowserPrepareArgs, BrowserRemoveArgs, BrowserStatusArgs, BudArgs};
use crate::lifecycle::{self, LifecyclePaths};

pub async fn prepare(args: &BudArgs, opts: &BrowserPrepareArgs) -> Result<()> {
    let base = args.resolved_paths().base_dir;
    std::fs::create_dir_all(addon::addon_dir(&base))?;
    let target = crate::upgrade::runtime_target()?;
    let dev = opts.helper_dir.is_some() || opts.node.is_some();

    // 1. Browser: explicit path, system detection, or managed plan B.
    let mut browser = if let Some(path) = &opts.browser {
        let path = PathBuf::from(shellexpand::tilde(path).into_owned());
        if !path.is_file() {
            bail!("{} is not a file", path.display());
        }
        println!("Using browser {}", path.display());
        BrowserRecord {
            kind: "system".into(),
            product: "custom".into(),
            path,
            version: String::new(),
        }
    } else if opts.managed {
        install_managed(&base, &target).await?
    } else {
        println!("Detecting browsers ...");
        let candidates = addon::detect_system_browsers();
        for candidate in &candidates {
            print_candidate(candidate);
        }
        match candidates.iter().find(|candidate| candidate.usable) {
            Some(candidate) => BrowserRecord {
                kind: "system".into(),
                product: candidate.product.id().into(),
                path: candidate.path.clone(),
                version: String::new(),
            },
            None => {
                if candidates.is_empty() {
                    println!("  none found");
                }
                let artifact =
                    addon::artifact_for(pins::MANAGED_BROWSER, &target).ok_or_else(|| {
                        anyhow!("no usable system browser and no managed build for {target}")
                    })?;
                let question = format!(
                    "No usable system browser. Install managed Chrome for Testing {} ({})?",
                    pins::MANAGED_BROWSER_VERSION,
                    human_size(artifact.size)
                );
                if !confirm(&question, opts.yes, false)? {
                    bail!(
                        "no usable system browser; install Google Chrome or Chromium, or run `bud browser prepare --managed`"
                    );
                }
                install_managed(&base, &target).await?
            }
        }
    };

    // 2. Node runtime.
    println!("Installing managed runtime ...");
    let node = match &opts.node {
        Some(path) => {
            let path = PathBuf::from(shellexpand::tilde(path).into_owned());
            if !path.is_file() {
                bail!("{} is not a file", path.display());
            }
            println!("  node (dev override)  {}", path.display());
            RuntimeRecord {
                path,
                version: "dev".into(),
            }
        }
        None => {
            let record = addon::install_node(&base, &target, progress("node")).await?;
            println!(
                "  node {:<10} verified   {}",
                pins::NODE_VERSION,
                addon::node_dir(&base).display()
            );
            record
        }
    };

    // 3. Helper.
    let helper = match &opts.helper_dir {
        Some(dir) => {
            let dir = PathBuf::from(shellexpand::tilde(dir).into_owned());
            let record = addon::helper_from_dir(&dir)?;
            println!("  helper (dev override) {}", dir.display());
            record
        }
        None => {
            let record = addon::install_embedded_helper(&base)?;
            println!(
                "  helper {:<8} playwright-core {}   {}",
                record.version,
                pins::PLAYWRIGHT_CORE_VERSION,
                addon::helper_dir(&base).display()
            );
            record
        }
    };

    // 4. Probe through the real launch path.
    let runtime = Runtime {
        executable: browser.path.clone(),
        node: node.path.clone(),
        helper: helper.path.clone(),
    };
    print!("Probing launch ... ");
    std::io::stdout().flush().ok();
    let outcome = match addon::probe(&runtime).await {
        Ok(outcome) => outcome,
        Err(error) => {
            println!("failed");
            // Nothing is recorded: the daemon must not advertise a browser that
            // did not prove itself.
            return Err(error.context(format!(
                "browser probe failed for {}; the manifest was not written",
                browser.path.display()
            )));
        }
    };
    println!("{} launched, answered CDP, closed", outcome.version);
    browser.version = outcome.version.clone();
    for note in &outcome.notes {
        println!("  note: {note}");
    }

    let manifest = Manifest {
        schema: addon::MANIFEST_SCHEMA,
        prepared_at: addon::now(),
        prepared_by: addon::daemon_version(),
        browser,
        node,
        helper,
        probe: ProbeRecord {
            ok: true,
            checked_at: addon::now(),
            notes: outcome.notes.clone(),
        },
        dev,
    };
    addon::write_manifest(&base, &manifest)?;
    println!("Wrote {}", addon::manifest_path(&base).display());
    if opts.json {
        println!("{}", serde_json::to_string_pretty(&manifest)?);
    }
    if outcome.notes.is_empty() {
        println!("Browser support is ready.");
    } else {
        println!("Browser support is prepared with caveats (see notes above).");
    }
    offer_restart(args, opts.yes, opts.no_restart)
}

pub async fn status(args: &BudArgs, opts: &BrowserStatusArgs) -> Result<()> {
    let base = args.resolved_paths().base_dir;
    let manifest = addon::read_manifest(&base)?;
    let override_runtime = addon::env_override().transpose()?;
    let probe = match (&override_runtime, &manifest) {
        (Some(runtime), _) => Some(addon::probe(runtime).await),
        (None, Some(manifest)) => Some(addon::probe(&manifest.runtime()).await),
        (None, None) => None,
    };
    let host_notes = host_caveats();
    if opts.json {
        let probe_json = probe.as_ref().map(|result| match result {
            Ok(outcome) => json!({"ok": true, "version": outcome.version, "notes": outcome.notes}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "prepared": manifest.is_some(),
                "override": override_runtime.is_some(),
                "manifest": manifest,
                "stale": manifest.as_ref().map(|m| m.stale()).unwrap_or_default(),
                "probe": probe_json,
                "host_notes": host_notes,
                "managed_present": addon::managed_present(&base).iter().map(|(name, path)| json!({"name": name, "path": path})).collect::<Vec<_>>(),
                "pins": {"node": pins::NODE_VERSION, "managed_browser": pins::MANAGED_BROWSER_VERSION, "playwright_core": pins::PLAYWRIGHT_CORE_VERSION, "browser_min_major": pins::BROWSER_MIN_MAJOR},
            }))?
        );
        return Ok(());
    }
    if let Some(runtime) = &override_runtime {
        println!(
            "Override: BUD_BROWSER_* environment ({})",
            runtime.executable.display()
        );
    }
    match &manifest {
        None if override_runtime.is_none() => {
            println!("Browser support is not prepared. Run `bud browser prepare`.");
        }
        None => {}
        Some(manifest) => {
            println!("Manifest: {}", addon::manifest_path(&base).display());
            println!(
                "  prepared {} by daemon {}{}",
                manifest.prepared_at,
                manifest.prepared_by,
                if manifest.dev { " (dev)" } else { "" }
            );
            println!(
                "  browser  {} {} {}",
                manifest.browser.kind, manifest.browser.product, manifest.browser.version
            );
            println!("           {}", manifest.browser.path.display());
            println!(
                "  node     {}  {}",
                manifest.node.version,
                manifest.node.path.display()
            );
            println!(
                "  helper   {}  {}",
                manifest.helper.version,
                manifest.helper.path.display()
            );
            for reason in manifest.stale() {
                println!("  stale:   {reason}; run `bud browser prepare` again");
            }
        }
    }
    match probe {
        Some(Ok(outcome)) => {
            println!("Probe: {} launched, answered CDP, closed", outcome.version);
            for note in outcome.notes {
                println!("  note: {note}");
            }
        }
        Some(Err(error)) => println!("Probe: failed ({error:#})"),
        None => {}
    }
    for note in host_notes {
        println!("Host: {note}");
    }
    let present = addon::managed_present(&base);
    if !present.is_empty() {
        println!("Managed pieces on disk:");
        for (name, path) in present {
            println!("  {name:<16} {}", path.display());
        }
    }
    Ok(())
}

pub fn remove(args: &BudArgs, opts: &BrowserRemoveArgs) -> Result<()> {
    let base = args.resolved_paths().base_dir;
    let removed_manifest = addon::remove_manifest(&base)?;
    println!(
        "{}",
        if removed_manifest {
            "Removed manifest."
        } else {
            "No manifest to remove."
        }
    );
    for (name, path) in addon::managed_present(&base) {
        if name == "managed browser" && opts.keep_managed_browser {
            println!("Kept {name} at {}", path.display());
            continue;
        }
        std::fs::remove_dir_all(&path)
            .with_context(|| format!("cannot remove {}", path.display()))?;
        println!("Removed {name} ({})", path.display());
    }
    let downloads = addon::downloads_dir(&base);
    if downloads.exists() {
        let _ = std::fs::remove_dir_all(&downloads);
    }
    let profiles = addon::profiles_dir(&base);
    if opts.profiles {
        if profiles.exists() {
            println!(
                "Deleting browser profiles (site sign-ins) at {}",
                profiles.display()
            );
            std::fs::remove_dir_all(&profiles)?;
        }
    } else if profiles.exists() {
        println!(
            "Profiles kept at {} (pass --profiles to delete site sign-ins).",
            profiles.display()
        );
    }
    if addon::addon_dir(&base).exists()
        && std::fs::read_dir(addon::addon_dir(&base))?.next().is_none()
    {
        let _ = std::fs::remove_dir(addon::addon_dir(&base));
    }
    offer_restart(args, opts.yes, opts.no_restart)
}

async fn install_managed(base: &Path, target: &str) -> Result<BrowserRecord> {
    println!(
        "Installing managed Chrome for Testing {} ...",
        pins::MANAGED_BROWSER_VERSION
    );
    let record = addon::install_managed_browser(base, target, progress("chrome")).await?;
    println!(
        "  chrome-for-testing verified   {}",
        addon::managed_browser_dir(base).display()
    );
    Ok(record)
}

fn print_candidate(candidate: &Candidate) {
    match &candidate.reason {
        None => println!(
            "  {:<14} {}",
            candidate.product.label(),
            candidate.path.display()
        ),
        Some(reason) => println!(
            "  {:<14} {}: {}",
            candidate.product.label(),
            candidate.path.display(),
            reason
        ),
    }
}

/// Caveats that hold on this host regardless of the manifest.
fn host_caveats() -> Vec<String> {
    let mut notes = Vec::new();
    if let Err(error) = crate::browser::secure_storage_ready() {
        notes.push(format!(
            "persistent profile unsupported on this host ({error}); the daemon will not advertise the browser until secure storage is validated (Phase 3o)"
        ));
    }
    if cfg!(target_os = "linux") {
        notes.push(
            "headed mode is unavailable on Linux (no display session passthrough yet; Phase 3o)"
                .into(),
        );
    }
    notes
}

fn progress(label: &'static str) -> impl FnMut(u64, Option<u64>) {
    let mut last = 0u64;
    move |received, total| {
        // One line per ~16 MiB keeps logs readable without a TTY.
        if received / (16 << 20) != last / (16 << 20) || Some(received) == total {
            match total {
                Some(total) => eprintln!(
                    "  {label}: {} / {}",
                    human_size(received),
                    human_size(total)
                ),
                None => eprintln!("  {label}: {}", human_size(received)),
            }
        }
        last = received;
    }
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1 << 30 {
        format!("{:.1} GB", bytes as f64 / (1u64 << 30) as f64)
    } else if bytes >= 1 << 20 {
        format!("{} MB", bytes >> 20)
    } else {
        format!("{} KB", bytes >> 10)
    }
}

/// Interactive yes/no. `assume_yes` answers yes; without a TTY the default wins.
fn confirm(question: &str, assume_yes: bool, default: bool) -> Result<bool> {
    if assume_yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        return Ok(default);
    }
    print!("{question} [{}] ", if default { "Y/n" } else { "y/N" });
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let answer = line.trim().to_ascii_lowercase();
    Ok(match answer.as_str() {
        "" => default,
        "y" | "yes" => true,
        _ => false,
    })
}

/// The daemon reads the manifest at startup, so changes take effect on restart.
fn offer_restart(args: &BudArgs, assume_yes: bool, no_restart: bool) -> Result<()> {
    let paths = LifecyclePaths::resolve(args)?;
    let running = paths.service_installed(lifecycle::ServiceManager::detect())
        || lifecycle::daemon_running(&paths);
    if !running {
        println!("Daemon is not running; it will pick up the change on `bud start`.");
        return Ok(());
    }
    if no_restart {
        println!("Restart the daemon to apply: bud restart");
        return Ok(());
    }
    if confirm(
        "Restart the daemon now to apply? Terminal sessions survive.",
        assume_yes,
        true,
    )? {
        lifecycle::restart(&paths)?;
        println!("Restarted. Terminal sessions reattach automatically.");
    } else {
        println!("Restart later with: bud restart");
    }
    Ok(())
}
