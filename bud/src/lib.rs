pub mod app;
pub mod claim;
pub mod config;
pub mod grpc_control;
pub mod identity;
pub mod journal;
pub mod proto_wire;
pub mod protocol;
pub mod run;
pub mod terminal;
pub mod transport;
pub mod util;

pub use config::BudArgs;
pub use util::setup_tracing;

pub async fn run(args: BudArgs) -> anyhow::Result<()> {
    app::BudApp::new(args).await.run().await
}
