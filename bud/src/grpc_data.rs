use anyhow::{Context, Result};
use serde_json::Value;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint};
use tonic::{Request, Streaming};

use crate::grpc_control::bud::v1::{bud_data_client::BudDataClient, BudEnvelope};
use crate::grpc_control::json_frame_to_envelope_with_transport;
use crate::proto_wire::EnvelopeTransportKind;

pub type GrpcDataStream = Streaming<BudEnvelope>;

pub async fn connect_data_stream(
    endpoint: &str,
    outbound: ReceiverStream<BudEnvelope>,
) -> Result<GrpcDataStream> {
    let channel = Endpoint::from_shared(endpoint.to_owned())
        .context("parse gRPC data endpoint")?
        .connect()
        .await
        .context("connect gRPC data endpoint")?;
    let mut client = BudDataClient::new(channel);
    Ok(client.attach(Request::new(outbound)).await?.into_inner())
}

pub fn json_frame_to_data_envelope(frame: &Value) -> Result<BudEnvelope> {
    json_frame_to_envelope_with_transport(frame, EnvelopeTransportKind::H2Data)
}

#[allow(dead_code)]
pub fn data_client(channel: Channel) -> BudDataClient<Channel> {
    BudDataClient::new(channel)
}
