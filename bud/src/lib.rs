pub mod app;
pub mod claim;
pub mod config;
pub mod doctor;
pub mod files;
pub mod grpc_control;
pub mod grpc_data;
pub mod identity;
pub mod journal;
pub mod lifecycle;
pub mod local_llm;
pub mod proto_wire;
pub mod protocol;
pub mod proxy;
pub mod run;
pub mod terminal;
pub mod transport;
pub mod util;
pub mod version;

pub use config::{BudArgs, BudCommand, LlmCommand, ServiceCommand};
pub use util::setup_tracing;

pub async fn run(args: BudArgs) -> anyhow::Result<()> {
    use lifecycle::LifecyclePaths;

    match args.command.clone() {
        Some(BudCommand::Doctor(doctor_args)) => doctor::run_doctor(&args, &doctor_args).await,
        Some(BudCommand::Claim) => app::BudApp::new(args).await.claim_only().await,
        Some(BudCommand::Run) | None => app::BudApp::new(args).await.run().await,
        Some(BudCommand::Start) => lifecycle::start(&LifecyclePaths::resolve(&args)?),
        Some(BudCommand::Stop) => lifecycle::stop(&LifecyclePaths::resolve(&args)?),
        Some(BudCommand::Restart) => lifecycle::restart(&LifecyclePaths::resolve(&args)?),
        Some(BudCommand::Status) => {
            lifecycle::status(&LifecyclePaths::resolve(&args)?, &args).await
        }
        Some(BudCommand::Logs(logs_args)) => lifecycle::logs(
            &LifecyclePaths::resolve(&args)?,
            logs_args.lines,
            logs_args.follow,
        ),
        Some(BudCommand::Service(service_cmd)) => {
            let paths = LifecyclePaths::resolve(&args)?;
            match service_cmd {
                ServiceCommand::Install => lifecycle::service_install(&paths),
                ServiceCommand::Uninstall => lifecycle::service_uninstall(&paths),
            }
        }
        Some(BudCommand::Llm(llm_cmd)) => {
            let paths = LifecyclePaths::resolve(&args)?;
            match llm_cmd {
                LlmCommand::Probe(probe_args) => {
                    lifecycle::llm_probe(&paths, &args, probe_args.url).await
                }
                LlmCommand::Enable(enable_args) => {
                    lifecycle::llm_enable(&paths, enable_args.url, enable_args.force).await
                }
                LlmCommand::Disable => lifecycle::llm_disable(&paths),
            }
        }
    }
}
