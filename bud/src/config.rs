use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

/// Bud (device agent) CLI arguments.
#[derive(Debug, Parser, Clone)]
#[command(name = "bud", about = "Bud device agent", version)]
pub struct BudArgs {
    #[arg(
        long,
        env = "BUD_SERVER_URL",
        default_value = "wss://localhost:8443/ws"
    )]
    pub server: String,

    #[arg(long, env = "BUD_GRPC_CONTROL_URL")]
    pub grpc_control_url: Option<String>,

    #[arg(long, env = "BUD_GRPC_DATA_URL")]
    pub grpc_data_url: Option<String>,

    #[arg(long, env = "BUD_ENROLLMENT_TOKEN")]
    pub token: Option<String>,

    #[arg(long, env = "BUD_CLAIM_ID")]
    pub claim_id: Option<String>,

    #[arg(long, env = "BUD_DEVICE_NAME", default_value = "bud-dev")]
    pub name: String,

    #[arg(long, env = "BUD_DEFAULT_CWD")]
    pub cwd: Option<String>,

    #[arg(long, env = "BUD_BASE_DIR")]
    pub base_dir: Option<String>,

    #[arg(long, env = "BUD_LOCAL", default_value_t = false)]
    pub local: bool,

    #[arg(long, env = "BUD_IDENTITY_FILE")]
    pub identity_file: Option<String>,

    #[arg(long, env = "BUD_RECONNECT_BASE_SEC", default_value_t = 5)]
    pub reconnect_base_sec: u64,

    #[arg(long, env = "BUD_TERMINAL_ENABLED", default_value_t = false)]
    pub terminal_enabled: bool,

    #[arg(long, env = "BUD_TERMINAL_BASE_DIR")]
    pub terminal_base_dir: Option<String>,

    #[arg(long, env = "BUD_TERMINAL_COLS", default_value_t = 200)]
    pub terminal_cols: u16,

    #[arg(long, env = "BUD_TERMINAL_ROWS", default_value_t = 50)]
    pub terminal_rows: u16,

    #[arg(long, env = "BUD_LOCAL_LLM_DS4_URL")]
    pub local_llm_ds4_url: Option<String>,

    #[arg(
        long,
        env = "BUD_LOCAL_LLM_DS4_CONTEXT_TOKENS",
        default_value_t = 100_000
    )]
    pub local_llm_ds4_context_tokens: u64,

    #[arg(
        long,
        env = "BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS",
        default_value_t = 384_000
    )]
    pub local_llm_ds4_max_output_tokens: u64,

    #[arg(long, env = "BUD_DEBUG", default_value_t = false)]
    pub debug: bool,

    #[command(subcommand)]
    pub command: Option<BudCommand>,
}

#[derive(Debug, Subcommand, Clone)]
pub enum BudCommand {
    Doctor(DoctorArgs),
}

#[derive(Debug, Args, Clone)]
pub struct DoctorArgs {
    #[arg(long, value_enum, default_value_t = DoctorFormat::Text)]
    pub format: DoctorFormat,

    #[arg(long, default_value_t = false)]
    pub strict: bool,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, ValueEnum)]
pub enum DoctorFormat {
    Text,
    Json,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ResolvedBudPaths {
    pub base_dir: PathBuf,
    pub default_cwd: PathBuf,
    pub identity_file: PathBuf,
    pub terminal_base_dir: PathBuf,
    pub local: bool,
}

impl BudArgs {
    pub fn resolved_paths(&self) -> ResolvedBudPaths {
        let launch_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let local = self.local;
        let base_dir = self
            .base_dir
            .as_deref()
            .map(expand_cli_path)
            .unwrap_or_else(|| {
                if local {
                    launch_dir.join(".bud")
                } else {
                    expand_cli_path("~/.bud")
                }
            });
        let default_cwd = self.cwd.as_deref().map(expand_cli_path).unwrap_or_else(|| {
            if local {
                launch_dir.clone()
            } else {
                expand_cli_path("~")
            }
        });
        let identity_file = self
            .identity_file
            .as_deref()
            .map(expand_cli_path)
            .unwrap_or_else(|| base_dir.join("identity.json"));
        let terminal_base_dir = self
            .terminal_base_dir
            .as_deref()
            .map(expand_cli_path)
            .unwrap_or_else(|| base_dir.clone());

        ResolvedBudPaths {
            base_dir,
            default_cwd,
            identity_file,
            terminal_base_dir,
            local,
        }
    }
}

fn expand_cli_path(path: &str) -> PathBuf {
    PathBuf::from(shellexpand::tilde(path).into_owned())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::BudArgs;

    fn args() -> BudArgs {
        BudArgs {
            server: "ws://127.0.0.1:3000/ws".into(),
            grpc_control_url: None,
            grpc_data_url: None,
            token: None,
            claim_id: None,
            name: "bud-test".into(),
            cwd: None,
            base_dir: None,
            local: false,
            identity_file: None,
            reconnect_base_sec: 1,
            terminal_enabled: false,
            terminal_base_dir: None,
            terminal_cols: 80,
            terminal_rows: 24,
            local_llm_ds4_url: None,
            local_llm_ds4_context_tokens: 100_000,
            local_llm_ds4_max_output_tokens: 384_000,
            debug: false,
            command: None,
        }
    }

    #[test]
    fn machine_mode_derives_paths_from_home_bud_dir() {
        let paths = args().resolved_paths();

        assert!(paths.base_dir.ends_with(".bud"));
        assert_eq!(paths.identity_file, paths.base_dir.join("identity.json"));
        assert_eq!(paths.terminal_base_dir, paths.base_dir);
        assert!(!paths.local);
    }

    #[test]
    fn local_mode_derives_base_dir_from_launch_directory() {
        let mut args = args();
        args.local = true;
        let launch_dir = std::env::current_dir().expect("current dir");
        let paths = args.resolved_paths();

        assert_eq!(paths.base_dir, launch_dir.join(".bud"));
        assert_eq!(paths.default_cwd, launch_dir);
        assert!(paths.local);
    }

    #[test]
    fn explicit_path_overrides_win() {
        let mut args = args();
        args.local = true;
        args.base_dir = Some("/tmp/bud-base".into());
        args.cwd = Some("/tmp/bud-work".into());
        args.identity_file = Some("/tmp/bud-identity.json".into());
        args.terminal_base_dir = Some("/tmp/bud-terminal".into());
        let paths = args.resolved_paths();

        assert_eq!(paths.base_dir, PathBuf::from("/tmp/bud-base"));
        assert_eq!(paths.default_cwd, PathBuf::from("/tmp/bud-work"));
        assert_eq!(paths.identity_file, PathBuf::from("/tmp/bud-identity.json"));
        assert_eq!(paths.terminal_base_dir, PathBuf::from("/tmp/bud-terminal"));
    }
}
