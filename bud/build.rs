use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    emit_build_metadata();
    embed_browser_helper()?;

    tonic_prost_build::configure()
        .build_server(false)
        .build_transport(false)
        .compile_protos(&["../proto/bud/v1/bud.proto"], &["../proto"])?;
    Ok(())
}

fn emit_build_metadata() {
    println!("cargo:rerun-if-env-changed=BUD_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=BUD_BUILD_TARGET");
    println!("cargo:rerun-if-env-changed=BUD_BUILD_VERSION");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    // Best-effort: a new tag without a new commit won't touch HEAD; a stale
    // describe until the next rebuild is acceptable for dev builds.
    println!("cargo:rerun-if-changed=../.git/refs/tags");

    let commit = std::env::var("BUD_BUILD_COMMIT")
        .ok()
        .or_else(git_commit)
        .unwrap_or_else(|| "unknown".to_string());
    let target = std::env::var("BUD_BUILD_TARGET")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_else(|_| "unknown".to_string());
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".to_string());

    println!("cargo:rustc-env=BUD_BUILD_COMMIT={}", commit);
    println!("cargo:rustc-env=BUD_BUILD_TARGET={}", target);
    println!("cargo:rustc-env=BUD_BUILD_PROFILE={}", profile);

    // Dev builds only (release builds get BUD_BUILD_VERSION from CI): a
    // precise self-description like `v0.1.9-14-g1845b9b-dirty`, so a local
    // binary can never be mistaken for a release. Absent outside a git
    // checkout (vendored source, tarball) — version.rs then falls back to
    // `v<crate>-dev`.
    if std::env::var("BUD_BUILD_VERSION").is_err() {
        if let Some(describe) = git_describe() {
            println!("cargo:rustc-env=BUD_BUILD_DESCRIBE={}", describe);
        }
    }
}

/// Pack `browser-helper/` (sources plus vendored `node_modules`, when present)
/// into `$OUT_DIR/browser-helper.tar.gz` for `bud browser prepare` to unpack.
/// Release builds run `npm ci --ignore-scripts` in the helper first; a checkout
/// without `node_modules` still builds, but the embedded helper is marked
/// incomplete and `prepare` requires `--helper-dir`.
fn embed_browser_helper() -> Result<(), Box<dyn std::error::Error>> {
    use std::path::Path;
    let helper = Path::new("browser-helper");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR")?).join("browser-helper.tar.gz");
    for file in [
        "main.mjs",
        "repl-worker.mjs",
        "repl-api.mjs",
        "repl-artifacts.mjs",
        "engine.mjs",
        "compact.mjs",
        "click-point.mjs",
        "diagnostics.mjs",
        "package.json",
        "package-lock.json",
    ] {
        println!("cargo:rerun-if-changed=browser-helper/{file}");
    }
    println!("cargo:rerun-if-changed=browser-helper/node_modules/.package-lock.json");
    let vendored = helper
        .join("node_modules/playwright-core/package.json")
        .is_file();
    println!(
        "cargo:rustc-env=BUD_HELPER_VENDORED={}",
        if vendored { "1" } else { "0" }
    );

    let file = std::fs::File::create(&out)?;
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        file,
        flate2::Compression::default(),
    ));
    builder.follow_symlinks(false);
    for file in [
        "main.mjs",
        "repl-worker.mjs",
        "repl-api.mjs",
        "repl-artifacts.mjs",
        "engine.mjs",
        "compact.mjs",
        "click-point.mjs",
        "diagnostics.mjs",
        "package.json",
        "package-lock.json",
    ] {
        let path = helper.join(file);
        if path.is_file() {
            builder.append_path_with_name(&path, file)?;
        }
    }
    if vendored {
        builder.append_dir_all("node_modules", helper.join("node_modules"))?;
    }
    builder.into_inner()?.finish()?;
    Ok(())
}

fn git_describe() -> Option<String> {
    let output = Command::new("git")
        .args(["describe", "--tags", "--long", "--always", "--dirty"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let describe = String::from_utf8(output.stdout).ok()?;
    let describe = describe.trim();
    if describe.is_empty() {
        None
    } else {
        Some(describe.to_string())
    }
}

fn git_commit() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8(output.stdout).ok()?;
    let commit = commit.trim();
    if commit.is_empty() {
        None
    } else {
        Some(commit.to_string())
    }
}
