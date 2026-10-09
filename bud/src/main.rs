use anyhow::Result;
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
    // launchd registers this binary directly; load configuration before Tokio.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("service-run")) {
        let mut args = std::env::args_os().skip(2);
        let base = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("service-run requires a base directory"))?;
        anyhow::ensure!(
            args.next().is_none(),
            "service-run accepts only a base directory"
        );
        return bud::lifecycle::service_run(std::path::Path::new(&base));
    }
    if bud::version::maybe_print_version_from_env() {
        return Ok(());
    }
    let args = bud::config::parse_with_defaults()?;
    daemon_main(args)
}

#[tokio::main]
async fn daemon_main(args: BudArgs) -> Result<()> {
    setup_tracing();
    let local = LocalSet::new();
    local.run_until(run(args)).await
}
