use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::proto_wire::encode_legacy_json_frame;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportKind {
    WebSocket,
}

#[derive(Clone)]
pub struct TransportSender {
    kind: TransportKind,
    inner: Arc<mpsc::UnboundedSender<Message>>,
    envelope_binary: bool,
}

impl TransportSender {
    pub fn websocket(sender: mpsc::UnboundedSender<Message>, envelope_binary: bool) -> Self {
        Self {
            kind: TransportKind::WebSocket,
            inner: Arc::new(sender),
            envelope_binary,
        }
    }

    pub fn kind(&self) -> TransportKind {
        self.kind
    }

    pub fn send_frame(&self, payload: Value) -> Result<()> {
        if self.envelope_binary {
            return self.send_message(Message::Binary(encode_legacy_json_frame(&payload)?));
        }
        let text = serde_json::to_string(&payload)?;
        self.send_message(Message::Text(text))
    }

    pub fn send_message(&self, message: Message) -> Result<()> {
        self.inner
            .send(message)
            .map_err(|_| anyhow!("transport disconnected"))
    }
}

pub type OutboundSender = TransportSender;

pub fn send_transport_frame(sender: &OutboundSender, payload: Value) -> Result<()> {
    sender.send_frame(payload)
}

pub fn send_transport_message(sender: &OutboundSender, message: Message) -> Result<()> {
    sender.send_message(message)
}
