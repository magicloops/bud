pub mod app;
pub mod claim;
pub mod config;
pub mod doctor;
pub mod files;
pub mod grpc_control;
pub mod grpc_data;
pub mod identity;
pub mod journal;
pub mod proto_wire;
pub mod protocol;
pub mod proxy;
pub mod run;
pub mod terminal;
pub mod transport;
pub mod util;
pub mod version;

pub use config::{BudArgs, BudCommand};
pub use util::setup_tracing;

pub async fn run(args: BudArgs) -> anyhow::Result<()> {
    if let Some(BudCommand::Doctor(doctor_args)) = args.command.clone() {
        return doctor::run_doctor(&args, &doctor_args).await;
    }

    app::BudApp::new(args).await.run().await
}
