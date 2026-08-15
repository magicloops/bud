use anyhow::Result;
use clap::Parser;
use tokio::task::LocalSet;

use bud::{run, setup_tracing, BudArgs};

fn main() -> Result<()> {
    // Hidden holder entrypoint (single-binary plan, stem design D1). Must run
    // before clap AND before any tokio runtime exists: the holder daemonizes
    // via fork, which is only sound in a single-threaded process.
    if std::env::args().nth(1).as_deref() == Some("term-hold") {
        let rest: Vec<String> = std::env::args().skip(2).collect();
        return stem::holder::main(&rest).map_err(|e| anyhow::anyhow!("term-hold: {e}"));
    }
    daemon_main()
}

#[tokio::main]
async fn daemon_main() -> Result<()> {
    if bud::version::maybe_print_version_from_env() {
        return Ok(());
    }

    setup_tracing();
    let args = BudArgs::parse();
    LocalSet::new().run_until(run(args)).await
}
