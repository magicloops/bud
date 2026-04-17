pub mod app;
pub mod claim;
pub mod config;
pub mod identity;
pub mod protocol;
pub mod run;
pub mod terminal;
pub mod util;

pub use config::BudArgs;
pub use util::setup_tracing;

pub async fn run(args: BudArgs) -> anyhow::Result<()> {
    app::BudApp::new(args).await.run().await
}
