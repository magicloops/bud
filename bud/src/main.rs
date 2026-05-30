use anyhow::Result;
use clap::Parser;
use tokio::task::LocalSet;

use bud::{run, setup_tracing, BudArgs};

#[tokio::main]
async fn main() -> Result<()> {
    if bud::version::maybe_print_version_from_env() {
        return Ok(());
    }

    setup_tracing();
    let args = BudArgs::parse();
    LocalSet::new().run_until(run(args)).await
}
