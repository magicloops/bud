use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use prost::Message;
use serde_json::Value;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint};
use tonic::{Request, Streaming};

use crate::proto_wire::{
    decode_legacy_json_frame, encode_typed_json_envelope, traffic_class_for_frame,
    EnvelopeTransportKind,
};
use crate::util::{new_message_id, now_millis};

pub mod bud {
    pub mod v1 {
        tonic::include_proto!("bud.v1");
    }
}

use bud::v1::{bud_control_client::BudControlClient, BudEnvelope};

pub type GrpcControlStream = Streaming<BudEnvelope>;

pub async fn connect_control_stream(
    endpoint: &str,
    outbound: ReceiverStream<BudEnvelope>,
) -> Result<GrpcControlStream> {
    let channel = Endpoint::from_shared(endpoint.to_owned())
        .context("parse gRPC control endpoint")?
        .connect()
        .await
        .context("connect gRPC control endpoint")?;
    let mut client = BudControlClient::new(channel);
    Ok(client.connect(Request::new(outbound)).await?.into_inner())
}

pub fn json_frame_to_envelope(frame: &Value) -> Result<BudEnvelope> {
    json_frame_to_envelope_with_transport(frame, EnvelopeTransportKind::H2Grpc)
}

pub fn json_frame_to_envelope_with_transport(
    frame: &Value,
    transport_kind: EnvelopeTransportKind,
) -> Result<BudEnvelope> {
    let frame_type = frame.get("type").and_then(Value::as_str);
    let proto = frame.get("proto").and_then(Value::as_str);
    let message_id = frame
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(new_message_id);
    let sent_at = frame
        .get("ts")
        .and_then(Value::as_u64)
        .map(timestamp_millis_to_rfc3339)
        .unwrap_or_else(|| timestamp_millis_to_rfc3339(now_millis()));
    let traffic_class = traffic_class_for_frame(frame);
    let frame_json = serde_json::to_vec(frame)?;
    let bytes = encode_typed_json_envelope(
        &message_id,
        &sent_at,
        traffic_class,
        transport_kind,
        frame_type,
        proto,
        &frame_json,
    )?;

    BudEnvelope::decode(bytes.as_slice()).map_err(Into::into)
}

pub fn envelope_to_json_text(envelope: &BudEnvelope) -> Result<String> {
    decode_legacy_json_frame(&envelope.encode_to_vec())
}

#[allow(dead_code)]
pub fn control_client(channel: Channel) -> BudControlClient<Channel> {
    BudControlClient::new(channel)
}

fn timestamp_millis_to_rfc3339(timestamp_millis: u64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_millis as i64)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
