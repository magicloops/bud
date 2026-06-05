use std::ffi::OsStr;

pub fn version_line() -> String {
    format!(
        "bud {} (commit {}, target {}, profile {})",
        env!("CARGO_PKG_VERSION"),
        build_commit(),
        build_target(),
        build_profile()
    )
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
    fn detects_version_args() {
        assert!(args_request_version(["bud", "--version"]));
        assert!(args_request_version(["bud", "-V"]));
        assert!(args_request_version(["bud", "doctor", "--version"]));
        assert!(!args_request_version(["bud", "doctor"]));
    }
}
