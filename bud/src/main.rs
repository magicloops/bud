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
    let local = LocalSet::new();
    let running = local.run_until(run(args));
    // Drop managed browser children on normal daemon shutdown. Detached
    // terminal holders retain their separate lifetime contract.
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = running => result,
            result = tokio::signal::ctrl_c() => result.map_err(Into::into),
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            result = running => result,
            result = tokio::signal::ctrl_c() => result.map_err(Into::into),
        }
    }
}
