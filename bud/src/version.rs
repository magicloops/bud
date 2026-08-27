use std::ffi::OsStr;

pub fn version_line() -> String {
    format!(
        "bud {} (commit {}, target {}, profile {})",
        release_version(),
        build_commit(),
        build_target(),
        build_profile()
    )
}

/// The RELEASE version this binary shipped as (the tag driving the release
/// workflow, baked at build time). Dev builds fall back to `git describe`
/// (baked by build.rs: `v0.1.9-14-g1845b9b-dirty`), else `v<crate>-dev` —
/// both unmistakably non-release. `bud upgrade` compares this against the
/// stable manifest, gated by [`is_release_build`] (a dev build always
/// "differs" from stable; the gate keeps that from being destructive).
pub fn release_version() -> &'static str {
    match option_env!("BUD_BUILD_VERSION") {
        Some(version) => version,
        None => option_env!("BUD_BUILD_DESCRIBE").unwrap_or(concat!(
            "v",
            env!("CARGO_PKG_VERSION"),
            "-dev"
        )),
    }
}

/// True when this binary was produced by the release pipeline
/// (`BUD_BUILD_VERSION` baked at compile time). Everything else — local
/// `cargo build`, CI test builds — is a dev build: `bud upgrade` refuses to
/// replace it without `--force`, and `bud status` skips the update nag.
pub fn is_release_build() -> bool {
    option_env!("BUD_BUILD_VERSION").is_some()
}

pub fn build_commit() -> &'static str {
    option_env!("BUD_BUILD_COMMIT").unwrap_or("unknown")
}

pub fn build_target() -> &'static str {
    option_env!("BUD_BUILD_TARGET").unwrap_or("unknown")
}

pub fn build_profile() -> &'static str {
    option_env!("BUD_BUILD_PROFILE").unwrap_or("unknown")
}

pub fn args_request_version<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| matches!(arg.as_ref().to_str(), Some("--version") | Some("-V")))
}

pub fn maybe_print_version_from_env() -> bool {
    if args_request_version(std::env::args_os()) {
        println!("{}", version_line());
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{args_request_version, build_target, version_line};

    #[test]
    fn version_line_includes_build_metadata() {
        let line = version_line();

        assert!(line.starts_with("bud "));
        assert!(line.contains("commit "));
        assert!(line.contains("target "));
        assert!(line.contains(build_target()));
    }

    #[test]
    fn dev_fallback_version_is_unmistakably_non_release() {
        // Test builds never bake BUD_BUILD_VERSION, so this exercises the
        // dev fallback: either a git describe (contains the commit / -dirty
        // suffix or is a tag we are exactly on) or the -dev crate fallback.
        // Both must never equal a bare release tag unless we ARE on one.
        if option_env!("BUD_BUILD_VERSION").is_none() {
            assert!(!super::is_release_build());
            let version = super::release_version();
            assert!(!version.is_empty());
            if option_env!("BUD_BUILD_DESCRIBE").is_none() {
                assert!(
                    version.ends_with("-dev"),
                    "crate fallback carries -dev: {version}"
                );
            }
        }
    }

    #[test]
    fn detects_version_args() {
        assert!(args_request_version(["bud", "--version"]));
        assert!(args_request_version(["bud", "-V"]));
        assert!(args_request_version(["bud", "doctor", "--version"]));
        assert!(!args_request_version(["bud", "doctor"]));
    }
}
