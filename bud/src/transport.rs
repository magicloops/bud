use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::mpsc;
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
    Grpc(mpsc::UnboundedSender<Value>),
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
            inner: Arc::new(TransportInner::Grpc(sender)),
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
            TransportInner::Grpc(sender) => sender
                .send(payload)
                .map_err(|_| anyhow!("transport disconnected")),
        }
    }

    pub fn send_message(&self, message: Message) -> Result<()> {
        match self.inner.as_ref() {
            TransportInner::WebSocket(sender) => sender
                .send(message)
                .map_err(|_| anyhow!("transport disconnected")),
            TransportInner::Grpc(_) => {
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
