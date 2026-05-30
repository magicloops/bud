use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    emit_build_metadata();

    tonic_prost_build::configure()
        .build_server(false)
        .build_transport(false)
        .compile_protos(&["../proto/bud/v1/bud.proto"], &["../proto"])?;
    Ok(())
}

fn emit_build_metadata() {
    println!("cargo:rerun-if-env-changed=BUD_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=BUD_BUILD_TARGET");
    println!("cargo:rerun-if-changed=../.git/HEAD");

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
