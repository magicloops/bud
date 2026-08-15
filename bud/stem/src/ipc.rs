//! Holder ⇄ client wire protocol over the per-session Unix domain socket.
//!
//! **This is the long-lived compatibility surface** (design D3c/D3d): holders keep
//! running across daemon upgrades, so evolution is ADDITIVE ONLY — new enum
//! variants may be appended, existing variants must never change shape or meaning,
//! and any breaking need bumps [`PROTO_VERSION`] plus a design-doc amendment.
//! The command set is deliberately closed (dumb-holder principle, D2/D3).
//!
//! Framing: `u32` little-endian payload length, then a postcard-encoded
//! [`ClientMsg`] / [`HolderMsg`]. Frames are capped at [`MAX_FRAME`].
//!
//! Connection model: a holder accepts multiple concurrent connections. A
//! connection is request/response until [`ClientMsg::Subscribe`] converts it to
//! push mode: the holder then streams [`HolderMsg::Output`] (and terminal-state
//! pushes) until close; further client frames on a subscribed connection are a
//! protocol error. The daemon conventionally holds one control connection and
//! one subscription.

use serde::{Deserialize, Serialize};

use crate::error::{Result, StemError};

/// Bump only for breaking changes; see module docs. Holders answer their own
/// version in [`HolderMsg::HelloAck`]; the client decides compatibility
/// (`holder < client` must be tolerated per D3d's N-2 policy).
pub const PROTO_VERSION: u16 = 1;

/// Hard cap on a single frame's postcard payload. Output pushes chunk below this.
pub const MAX_FRAME: usize = 256 * 1024;

/// Preferred maximum bytes per [`HolderMsg::Output`] push. Small enough to keep
/// latency low and let the daemon re-chunk to its ≤16 KiB wire frames cheaply.
pub const OUTPUT_CHUNK: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientMsg {
    /// Must be the first frame on every connection.
    Hello { proto_version: u16 },
    /// Write raw bytes to the PTY master (ordering guaranteed per connection).
    Write { bytes: Vec<u8> },
    /// Resize the PTY (TIOCSWINSZ + SIGWINCH to the foreground group).
    Resize { cols: u16, rows: u16 },
    /// Convert this connection to push mode, replaying ring content from
    /// `from_offset` (absolute since session start) before live output.
    Subscribe { from_offset: u64 },
    /// Read a byte range from the ring without subscribing. The holder may
    /// return FEWER bytes than requested (responses are capped well below
    /// [`MAX_FRAME`]); `RingData.start`+len tells the client where to resume.
    /// A `from`/`start` beyond the ring's next offset clamps to next offset.
    RingRead { start: u64, end: u64 },
    /// Ring extent, child liveness, and PTY geometry.
    Stat,
    /// SIGKILL the child, remove the socket, exit the holder.
    Kill,
    /// Exit the holder WITHOUT killing the child is not supported — the holder
    /// owns the PTY; orphaning it would leak. `Shutdown` kills child then exits
    /// (alias of Kill semantics today; kept distinct for future TTL logic).
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HolderMsg {
    HelloAck {
        proto_version: u16,
        /// Holder binary's crate version string (diagnostics only — never branch on it).
        holder_version: String,
        child_pid: i32,
    },
    /// Generic success for Write/Resize/Kill/Shutdown.
    Ok,
    Err {
        msg: String,
    },
    /// Push-mode output. `offset` addresses the FIRST byte of `bytes`, absolute
    /// from session start; contiguous, monotonic, never resets.
    Output {
        offset: u64,
        bytes: Vec<u8>,
    },
    /// Sent (push mode) before any Output when `from_offset` predates the ring's
    /// oldest retained byte: the gap [from_offset, oldest_offset) is lost.
    Truncated {
        oldest_offset: u64,
    },
    /// Push-mode notification; the holder stays alive afterwards (ring remains
    /// readable) until Kill or its post-exit TTL fires.
    ChildExited {
        /// Exit code if the child exited normally.
        exit_code: Option<i32>,
        /// Signal number if signal-terminated.
        signal: Option<i32>,
    },
    StatAck {
        ring_oldest_offset: u64,
        ring_next_offset: u64,
        child_pid: i32,
        child_alive: bool,
        cols: u16,
        rows: u16,
    },
    RingData {
        start: u64,
        bytes: Vec<u8>,
        /// Set when `start` was clamped forward past truncated bytes.
        truncated_from: Option<u64>,
    },
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

pub fn encode_frame<T: Serialize>(msg: &T) -> Result<Vec<u8>> {
    let payload = postcard::to_stdvec(msg).map_err(|e| StemError::Ipc(e.to_string()))?;
    if payload.len() > MAX_FRAME {
        return Err(StemError::FrameTooLarge {
            size: payload.len(),
            max: MAX_FRAME,
        });
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

pub fn decode_payload<'a, T: Deserialize<'a>>(payload: &'a [u8]) -> Result<T> {
    postcard::from_bytes(payload).map_err(|e| StemError::Ipc(e.to_string()))
}

/// Sync read of one frame payload (holder side).
pub fn read_frame_sync(r: &mut impl std::io::Read) -> Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(StemError::FrameTooLarge {
            size: len,
            max: MAX_FRAME,
        });
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

/// Sync write of one message (holder side).
pub fn write_msg_sync<T: Serialize>(w: &mut impl std::io::Write, msg: &T) -> Result<()> {
    let frame = encode_frame(msg)?;
    w.write_all(&frame)?;
    w.flush()?;
    Ok(())
}

/// Async read of one frame payload (client side).
pub async fn read_frame_async(r: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(StemError::FrameTooLarge {
            size: len,
            max: MAX_FRAME,
        });
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Async write of one message (client side).
pub async fn write_msg_async<T: Serialize>(
    w: &mut (impl tokio::io::AsyncWrite + Unpin),
    msg: &T,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let frame = encode_frame(msg)?;
    w.write_all(&frame).await?;
    w.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_client_msgs() {
        for msg in [
            ClientMsg::Hello {
                proto_version: PROTO_VERSION,
            },
            ClientMsg::Write {
                bytes: b"ls -la\r".to_vec(),
            },
            ClientMsg::Subscribe { from_offset: 12345 },
            ClientMsg::RingRead { start: 0, end: 999 },
        ] {
            let frame = encode_frame(&msg).unwrap();
            let (len, payload) = frame.split_at(4);
            assert_eq!(
                u32::from_le_bytes(len.try_into().unwrap()) as usize,
                payload.len()
            );
            let back: ClientMsg = decode_payload(payload).unwrap();
            assert_eq!(back, msg);
        }
    }

    #[test]
    fn roundtrip_holder_msgs() {
        let msg = HolderMsg::Output {
            offset: 42,
            bytes: vec![0xE2, 0x82],
        };
        let frame = encode_frame(&msg).unwrap();
        let back: HolderMsg = decode_payload(&frame[4..]).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn oversized_frame_rejected() {
        let msg = ClientMsg::Write {
            bytes: vec![0u8; MAX_FRAME + 1],
        };
        assert!(matches!(
            encode_frame(&msg),
            Err(StemError::FrameTooLarge { .. })
        ));
    }
}
