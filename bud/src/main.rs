use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tracing::{info, warn};
use tracing_subscriber::{fmt, EnvFilter};

/// Bud (device agent) CLI arguments.
#[derive(Debug, Parser)]
#[command(name = "bud", about = "Bud device agent PoC", version)]
struct BudArgs {
    /// Backend WSS endpoint (e.g., wss://bud.dev/ws).
    #[arg(
        long,
        env = "BUD_SERVER_URL",
        default_value = "wss://localhost:8443/ws"
    )]
    server: String,

    /// Enrollment token for first-time registration.
    #[arg(long, env = "BUD_ENROLLMENT_TOKEN")]
    token: Option<String>,

    /// Friendly device name presented in the UI.
    #[arg(long, env = "BUD_DEVICE_NAME", default_value = "bud-dev")]
    name: String,

    /// Default working directory for shell commands.
    #[arg(long, env = "BUD_DEFAULT_CWD", default_value = "~")]
    cwd: String,

    /// Path to the device identity file (bud_id + device_secret).
    #[arg(
        long,
        env = "BUD_IDENTITY_FILE",
        default_value = "~/.bud/identity.json"
    )]
    identity_file: String,

    /// Minimum seconds between reconnect attempts.
    #[arg(long, env = "BUD_RECONNECT_BASE_SEC", default_value_t = 5)]
    reconnect_base_sec: u64,
}

struct BudApp {
    args: BudArgs,
    identity_path: PathBuf,
}

impl BudApp {
    fn new(args: BudArgs) -> Self {
        let identity_path = shellexpand::tilde(&args.identity_file).into_owned().into();
        Self {
            args,
            identity_path,
        }
    }

    async fn run(self) -> Result<()> {
        info!(
            target: "bud",
            server = %self.args.server,
            name = %self.args.name,
            cwd = %self.args.cwd,
            identity = %self.identity_path.display(),
            "Bud agent scaffolding ready"
        );
        warn!(
            "WSS handshake and shell execution are not implemented yet. See plan/phase-0-scaffolding.md."
        );
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    setup_tracing();
    let args = BudArgs::parse();
    BudApp::new(args).run().await
}

fn setup_tracing() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(env_filter).with_target(false).init();
}
