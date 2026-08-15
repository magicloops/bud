//! Async client for one holder (daemon-side). Thin: raw bytes and IPC ops only —
//! emulation/semantics live in [`crate::session`].

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::error::{Result, StemError};
use crate::ipc::{self, ClientMsg, HolderMsg, PROTO_VERSION};

/// Per-op deadline: a holder is local and either answers fast or is wedged.
const OP_TIMEOUT: Duration = Duration::from_secs(10);

/// One request/response control connection to a holder.
#[derive(Debug)]
pub struct HolderClient {
    stream: UnixStream,
    session_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloInfo {
    pub proto_version: u16,
    pub holder_version: String,
    pub child_pid: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub ring_oldest_offset: u64,
    pub ring_next_offset: u64,
    pub child_pid: i32,
    pub child_alive: bool,
    pub cols: u16,
    pub rows: u16,
}

/// Push-mode events from a subscription connection. Wraps only the push-legal
/// subset of [`HolderMsg`] (`Output`, `Truncated`, `ChildExited`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HolderPush {
    Output {
        offset: u64,
        bytes: Vec<u8>,
    },
    Truncated {
        oldest_offset: u64,
    },
    ChildExited {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
    /// Subscription connection ended (holder died or socket closed).
    Closed,
}

/// Map connection-phase io errors to `SessionGone` (dead holder / stale socket);
/// protocol-level errors pass through unchanged.
fn gone_on_io(err: StemError, dir: &Path) -> StemError {
    match err {
        StemError::Io(_) => StemError::SessionGone {
            dir: dir.to_path_buf(),
        },
        other => other,
    }
}

/// Connect + Hello + HelloAck on a fresh stream.
async fn open_stream(session_dir: &Path) -> Result<(UnixStream, HelloInfo)> {
    let sock = session_dir.join("holder.sock");
    let mut stream = UnixStream::connect(&sock)
        .await
        .map_err(|_| StemError::SessionGone {
            dir: session_dir.to_path_buf(),
        })?;
    ipc::write_msg_async(
        &mut stream,
        &ClientMsg::Hello {
            proto_version: PROTO_VERSION,
        },
    )
    .await
    .map_err(|e| gone_on_io(e, session_dir))?;
    let payload = timeout(OP_TIMEOUT, ipc::read_frame_async(&mut stream))
        .await
        .map_err(|_| StemError::Other("holder Hello timed out".into()))?
        .map_err(|e| gone_on_io(e, session_dir))?;
    match ipc::decode_payload::<HolderMsg>(&payload)? {
        HolderMsg::HelloAck {
            proto_version,
            holder_version,
            child_pid,
        } => {
            if proto_version > PROTO_VERSION {
                // A holder OLDER than the client is accepted (D3d N-2 policy);
                // only a newer holder is refused.
                return Err(StemError::VersionMismatch {
                    holder: proto_version,
                    client: PROTO_VERSION,
                });
            }
            Ok((
                stream,
                HelloInfo {
                    proto_version,
                    holder_version,
                    child_pid,
                },
            ))
        }
        HolderMsg::Err { msg } => Err(StemError::Holder(msg)),
        other => Err(StemError::Ipc(format!("expected HelloAck, got {other:?}"))),
    }
}

impl HolderClient {
    /// Connect to `<session_dir>/holder.sock` and perform Hello. Maps a dead or
    /// missing socket to [`crate::StemError::SessionGone`], and an incompatible
    /// holder to `VersionMismatch`.
    pub async fn connect(session_dir: &Path) -> Result<(Self, HelloInfo)> {
        let (stream, info) = open_stream(session_dir).await?;
        Ok((
            HolderClient {
                stream,
                session_dir: session_dir.to_path_buf(),
            },
            info,
        ))
    }

    pub fn session_dir(&self) -> &PathBuf {
        &self.session_dir
    }

    async fn request(&mut self, msg: &ClientMsg) -> Result<HolderMsg> {
        ipc::write_msg_async(&mut self.stream, msg).await?;
        let payload = timeout(OP_TIMEOUT, ipc::read_frame_async(&mut self.stream))
            .await
            .map_err(|_| StemError::Other("holder op timed out".into()))??;
        match ipc::decode_payload::<HolderMsg>(&payload)? {
            HolderMsg::Err { msg } => Err(StemError::Holder(msg)),
            other => Ok(other),
        }
    }

    async fn request_ok(&mut self, msg: &ClientMsg) -> Result<()> {
        match self.request(msg).await? {
            HolderMsg::Ok => Ok(()),
            other => Err(StemError::Ipc(format!("expected Ok, got {other:?}"))),
        }
    }

    pub async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.request_ok(&ClientMsg::Write {
            bytes: bytes.to_vec(),
        })
        .await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.request_ok(&ClientMsg::Resize { cols, rows }).await
    }

    pub async fn stat(&mut self) -> Result<Stat> {
        match self.request(&ClientMsg::Stat).await? {
            HolderMsg::StatAck {
                ring_oldest_offset,
                ring_next_offset,
                child_pid,
                child_alive,
                cols,
                rows,
            } => Ok(Stat {
                ring_oldest_offset,
                ring_next_offset,
                child_pid,
                child_alive,
                cols,
                rows,
            }),
            other => Err(StemError::Ipc(format!("expected StatAck, got {other:?}"))),
        }
    }

    pub async fn ring_read(&mut self, start: u64, end: u64) -> Result<HolderMsg> {
        match self.request(&ClientMsg::RingRead { start, end }).await? {
            msg @ HolderMsg::RingData { .. } => Ok(msg),
            other => Err(StemError::Ipc(format!("expected RingData, got {other:?}"))),
        }
    }

    pub async fn kill(&mut self) -> Result<()> {
        match self.request_ok(&ClientMsg::Kill).await {
            Ok(()) => Ok(()),
            // The holder replies Ok then exits; tolerate the reply losing the race.
            Err(StemError::Io(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Open a SECOND connection in push mode. Spawns a reader task feeding the
    /// returned channel until close; dropping the receiver detaches cleanly.
    pub async fn subscribe(
        session_dir: &Path,
        from_offset: u64,
    ) -> Result<mpsc::Receiver<HolderPush>> {
        let (mut stream, _info) = open_stream(session_dir).await?;
        ipc::write_msg_async(&mut stream, &ClientMsg::Subscribe { from_offset })
            .await
            .map_err(|e| gone_on_io(e, session_dir))?;
        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(async move {
            loop {
                let push = match ipc::read_frame_async(&mut stream).await {
                    Ok(payload) => match ipc::decode_payload::<HolderMsg>(&payload) {
                        Ok(HolderMsg::Output { offset, bytes }) => {
                            HolderPush::Output { offset, bytes }
                        }
                        Ok(HolderMsg::Truncated { oldest_offset }) => {
                            HolderPush::Truncated { oldest_offset }
                        }
                        Ok(HolderMsg::ChildExited { exit_code, signal }) => {
                            HolderPush::ChildExited { exit_code, signal }
                        }
                        Ok(_) | Err(_) => break,
                    },
                    Err(_) => break,
                };
                if tx.send(push).await.is_err() {
                    return; // receiver dropped: detach silently
                }
            }
            let _ = tx.send(HolderPush::Closed).await;
        });
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{read_frame_sync, write_msg_sync};
    use std::os::unix::net::UnixListener;

    /// Fake holder answering Hello with an arbitrary proto version.
    fn fake_holder(dir: &Path, answer_version: u16) -> std::thread::JoinHandle<()> {
        let listener = UnixListener::bind(dir.join("holder.sock")).unwrap();
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let payload = read_frame_sync(&mut conn).unwrap();
            let msg: ClientMsg = ipc::decode_payload(&payload).unwrap();
            assert!(matches!(
                msg,
                ClientMsg::Hello {
                    proto_version: PROTO_VERSION
                }
            ));
            write_msg_sync(
                &mut conn,
                &HolderMsg::HelloAck {
                    proto_version: answer_version,
                    holder_version: "fake".into(),
                    child_pid: 42,
                },
            )
            .unwrap();
            // Hold the connection open briefly so the client reads the ack.
            std::thread::sleep(Duration::from_millis(200));
        })
    }

    #[tokio::test]
    async fn newer_holder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let server = fake_holder(dir.path(), PROTO_VERSION + 1);
        let err = HolderClient::connect(dir.path()).await.unwrap_err();
        match err {
            StemError::VersionMismatch { holder, client } => {
                assert_eq!(holder, PROTO_VERSION + 1);
                assert_eq!(client, PROTO_VERSION);
            }
            other => panic!("expected VersionMismatch, got {other:?}"),
        }
        server.join().unwrap();
    }

    #[tokio::test]
    async fn older_holder_is_accepted() {
        // holder < client must be tolerated per D3d's N-2 policy.
        let dir = tempfile::tempdir().unwrap();
        let server = fake_holder(dir.path(), 0);
        let (client, info) = HolderClient::connect(dir.path()).await.unwrap();
        assert_eq!(info.proto_version, 0);
        assert_eq!(info.holder_version, "fake");
        assert_eq!(info.child_pid, 42);
        assert_eq!(client.session_dir(), &dir.path().to_path_buf());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn missing_socket_is_session_gone() {
        let dir = tempfile::tempdir().unwrap();
        let err = HolderClient::connect(dir.path()).await.unwrap_err();
        assert!(matches!(err, StemError::SessionGone { .. }));
    }
}
