use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::proto_wire::encode_legacy_json_frame;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportKind {
    WebSocket,
    Grpc,
}

#[derive(Clone)]
pub struct TransportSender {
    kind: TransportKind,
    inner: Arc<TransportInner>,
    envelope_binary: bool,
}

enum TransportInner {
    WebSocket(mpsc::UnboundedSender<Message>),
    Grpc {
        control: mpsc::UnboundedSender<Value>,
        data: Option<mpsc::Sender<Value>>,
    },
}

enum DataRoutePolicy {
    Control,
    DataWithControlFallback,
    DataRequired,
}

impl TransportSender {
    pub fn websocket(sender: mpsc::UnboundedSender<Message>, envelope_binary: bool) -> Self {
        Self {
            kind: TransportKind::WebSocket,
            inner: Arc::new(TransportInner::WebSocket(sender)),
            envelope_binary,
        }
    }

    pub fn grpc(sender: mpsc::UnboundedSender<Value>) -> Self {
        Self {
            kind: TransportKind::Grpc,
            inner: Arc::new(TransportInner::Grpc {
                control: sender,
                data: None,
            }),
            envelope_binary: true,
        }
    }

    pub fn grpc_with_data(
        control: mpsc::UnboundedSender<Value>,
        data: mpsc::Sender<Value>,
    ) -> Self {
        Self {
            kind: TransportKind::Grpc,
            inner: Arc::new(TransportInner::Grpc {
                control,
                data: Some(data),
            }),
            envelope_binary: true,
        }
    }

    pub fn kind(&self) -> TransportKind {
        self.kind
    }

    pub fn send_frame(&self, payload: Value) -> Result<()> {
        match self.inner.as_ref() {
            TransportInner::WebSocket(_) => {
                if self.envelope_binary {
                    return self.send_message(Message::Binary(encode_legacy_json_frame(&payload)?));
                }
                let text = serde_json::to_string(&payload)?;
                self.send_message(Message::Text(text))
            }
            TransportInner::Grpc { control, data } => match data_route_policy(&payload) {
                DataRoutePolicy::Control => control
                    .send(payload)
                    .map_err(|_| anyhow!("transport disconnected")),
                DataRoutePolicy::DataWithControlFallback => {
                    let payload = match data {
                        Some(sender) => match sender.try_send(payload) {
                            Ok(()) => return Ok(()),
                            Err(TrySendError::Full(payload))
                            | Err(TrySendError::Closed(payload)) => payload,
                        },
                        None => payload,
                    };
                    control
                        .send(payload)
                        .map_err(|_| anyhow!("transport disconnected"))
                }
                DataRoutePolicy::DataRequired => {
                    let Some(sender) = data else {
                        return Err(anyhow!("gRPC data channel unavailable"));
                    };
                    sender
                        .try_send(payload)
                        .map_err(|_| anyhow!("gRPC data channel unavailable"))
                }
            },
        }
    }

    pub fn send_message(&self, message: Message) -> Result<()> {
        match self.inner.as_ref() {
            TransportInner::WebSocket(sender) => sender
                .send(message)
                .map_err(|_| anyhow!("transport disconnected")),
            TransportInner::Grpc { .. } => {
                Err(anyhow!("transport does not support raw websocket messages"))
            }
        }
    }
}

pub type OutboundSender = TransportSender;

pub fn send_transport_frame(sender: &OutboundSender, payload: Value) -> Result<()> {
    sender.send_frame(payload)
}

pub fn send_transport_message(sender: &OutboundSender, message: Message) -> Result<()> {
    sender.send_message(message)
}

fn data_route_policy(payload: &Value) -> DataRoutePolicy {
    match payload.get("type").and_then(Value::as_str) {
        Some("terminal_output") => DataRoutePolicy::DataWithControlFallback,
        Some("stream_data" | "stream_credit" | "stream_reset" | "stream_close") => {
            DataRoutePolicy::DataRequired
        }
        _ => DataRoutePolicy::Control,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn grpc_sender_routes_terminal_output_to_data_channel() {
        let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Value>();
        let (data_tx, mut data_rx) = mpsc::channel::<Value>(8);
        let sender = TransportSender::grpc_with_data(control_tx, data_tx);
        let frame = json!({
            "proto": "0.2",
            "type": "terminal_output",
            "id": "msg_output",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "sess_test",
            "seq": 1,
            "data": "",
            "byte_offset": 0
        });

        sender.send_frame(frame.clone()).expect("send frame");

        assert_eq!(data_rx.recv().await, Some(frame));
        assert!(control_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn grpc_sender_keeps_control_frames_on_control_channel() {
        let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Value>();
        let (data_tx, mut data_rx) = mpsc::channel::<Value>(8);
        let sender = TransportSender::grpc_with_data(control_tx, data_tx);
        let frame = json!({
            "proto": "0.1",
            "type": "heartbeat",
            "id": "msg_heartbeat",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "s_test"
        });

        sender.send_frame(frame.clone()).expect("send frame");

        assert_eq!(control_rx.recv().await, Some(frame));
        assert!(data_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn grpc_sender_falls_back_to_control_when_data_channel_is_closed() {
        let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Value>();
        let (data_tx, data_rx) = mpsc::channel::<Value>(8);
        drop(data_rx);
        let sender = TransportSender::grpc_with_data(control_tx, data_tx);
        let frame = json!({
            "proto": "0.2",
            "type": "terminal_output",
            "id": "msg_output",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "sess_test",
            "seq": 1,
            "data": "",
            "byte_offset": 0
        });

        sender.send_frame(frame.clone()).expect("send frame");

        assert_eq!(control_rx.recv().await, Some(frame));
    }

    #[tokio::test]
    async fn grpc_sender_fails_stream_frames_when_data_channel_is_closed() {
        let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Value>();
        let (data_tx, data_rx) = mpsc::channel::<Value>(8);
        drop(data_rx);
        let sender = TransportSender::grpc_with_data(control_tx, data_tx);
        let frame = json!({
            "proto": "0.1",
            "type": "stream_data",
            "id": "msg_stream_data",
            "ts": 1777132800000_u64,
            "ext": {},
            "stream_id": "st_test",
            "stream_type": "localhost_http_proxy",
            "offset": 0,
            "data": "",
            "end_stream": false
        });

        assert!(sender.send_frame(frame).is_err());
        assert!(control_rx.try_recv().is_err());
    }
}
