use clap::Parser;

/// Bud (device agent) CLI arguments.
#[derive(Debug, Parser, Clone)]
#[command(name = "bud", about = "Bud device agent PoC", version)]
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

    #[arg(long, env = "BUD_DEVICE_NAME", default_value = "bud-dev")]
    pub name: String,

    #[arg(long, env = "BUD_DEFAULT_CWD", default_value = "~")]
    pub cwd: String,

    #[arg(
        long,
        env = "BUD_IDENTITY_FILE",
        default_value = "~/.bud/identity.json"
    )]
    pub identity_file: String,

    #[arg(long, env = "BUD_RECONNECT_BASE_SEC", default_value_t = 5)]
    pub reconnect_base_sec: u64,

    #[arg(long, env = "BUD_TERMINAL_ENABLED", default_value_t = false)]
    pub terminal_enabled: bool,

    #[arg(long, env = "BUD_TERMINAL_BASE_DIR", default_value = "~/.bud")]
    pub terminal_base_dir: String,

    #[arg(long, env = "BUD_TERMINAL_COLS", default_value_t = 200)]
    pub terminal_cols: u16,

    #[arg(long, env = "BUD_TERMINAL_ROWS", default_value_t = 50)]
    pub terminal_rows: u16,

    #[arg(long, env = "BUD_DEBUG", default_value_t = false)]
    pub debug: bool,
}
