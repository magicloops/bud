use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{mpsc, Mutex};
use tokio::task;
use tracing::warn;

use crate::protocol::{FileOpenFrame, StreamCreditFrame, StreamResetFrame, PROTO_VERSION};
use crate::transport::{send_transport_frame, TransportSender};
use crate::util::{new_message_id, now_millis};

const FILE_READ_STREAM_TYPE: &str = "file_read";
const WORKSPACE_ROOT_KEY: &str = "workspace";
const DEFAULT_INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES: usize = 16 * 1024;
const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct FileManager {
    workspace_root: Arc<PathBuf>,
    streams: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<FileStreamEvent>>>>,
}

enum FileStreamEvent {
    Credit { credit_bytes: u64 },
    Reset { reason: String },
}

struct FileReadResponse {
    status_code: u16,
    headers: HashMap<String, String>,
    content_identity: Value,
    size: u64,
    body: Vec<u8>,
}

#[derive(Debug)]
struct FileOpenRejection {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl FileManager {
    pub fn new(workspace_root: PathBuf) -> Self {
        let workspace_root = std::fs::canonicalize(&workspace_root).unwrap_or(workspace_root);
        Self {
            workspace_root: Arc::new(workspace_root),
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn handle_open(&self, frame: FileOpenFrame, sender: TransportSender) {
        let manager = self.clone();
        task::spawn_local(async move {
            if let Err(err) = manager.run_file(frame, sender).await {
                warn!(error = %err, "file read stream task failed");
            }
        });
    }

    pub async fn apply_credit(&self, frame: StreamCreditFrame) {
        let streams = self.streams.lock().await;
        if let Some(sender) = streams.get(&frame.stream_id) {
            let _ = sender.send(FileStreamEvent::Credit {
                credit_bytes: frame.credit_bytes,
            });
        }
    }

    pub async fn apply_reset(&self, frame: StreamResetFrame) {
        let sender = {
            let mut streams = self.streams.lock().await;
            streams.remove(&frame.stream_id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(FileStreamEvent::Reset {
                reason: frame.reason,
            });
        }
    }

    async fn run_file(&self, frame: FileOpenFrame, sender: TransportSender) -> Result<()> {
        if let Err(err) = validate_file_open_frame(&frame) {
            send_file_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }

        let (credit_tx, mut credit_rx) = mpsc::unbounded_channel();
        self.register_stream(frame.stream_id.clone(), credit_tx)
            .await;

        let result = self
            .run_validated_file(frame.clone(), sender.clone(), &mut credit_rx)
            .await;
        self.unregister_stream(&frame.stream_id).await;

        if let Err(err) = result {
            warn!(
                stream_id = %frame.stream_id,
                operation_id = %frame.operation_id,
                error = %err,
                "file read stream ended with error"
            );
        }
        Ok(())
    }

    async fn run_validated_file(
        &self,
        frame: FileOpenFrame,
        sender: TransportSender,
        credit_rx: &mut mpsc::UnboundedReceiver<FileStreamEvent>,
    ) -> Result<()> {
        let response = match self.read_file_response(&frame).await {
            Ok(response) => response,
            Err(rejection) => {
                send_file_open_rejected(
                    &sender,
                    &frame,
                    rejection.code,
                    &rejection.message,
                    rejection.retryable,
                )?;
                return Ok(());
            }
        };

        send_file_open_accepted(&sender, &frame, &response)?;

        let max_chunk_bytes = frame
            .max_chunk_bytes
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_CHUNK_BYTES)
            .clamp(1, MAX_CHUNK_BYTES_LIMIT);
        let mut available_credit = frame
            .initial_credit_bytes
            .unwrap_or(DEFAULT_INITIAL_CREDIT_BYTES);
        let mut offset = 0_u64;

        for segment in response.body.chunks(max_chunk_bytes) {
            if let Err(err) =
                wait_for_credit(&mut available_credit, segment.len() as u64, credit_rx).await
            {
                warn!(
                    stream_id = %frame.stream_id,
                    error = %err,
                    "stopping file stream while waiting for credit"
                );
                return Ok(());
            }
            send_stream_data(&sender, &frame, offset, segment, false)?;
            available_credit = available_credit.saturating_sub(segment.len() as u64);
            offset += segment.len() as u64;
        }

        send_stream_close(&sender, &frame.stream_id, offset)
    }

    async fn read_file_response(
        &self,
        frame: &FileOpenFrame,
    ) -> std::result::Result<FileReadResponse, FileOpenRejection> {
        let max_bytes = frame.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
        let path = self.resolve_workspace_file(frame).await?;
        let before = tokio::fs::metadata(&path)
            .await
            .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
        let before_identity = content_identity(&before);
        if let Some(expected) = &frame.expected_content_identity {
            if expected != &before_identity {
                return Err(FileOpenRejection::new(
                    "CONTENT_CHANGED",
                    "file content identity changed before read",
                    false,
                ));
            }
        }

        let selection = select_file_bytes(frame, before.len(), max_bytes)?;
        let mut headers =
            response_headers(before.len(), selection.content_length, &before_identity);
        if let Some(content_range) = selection.content_range {
            headers.insert("content-range".into(), content_range);
        }

        let body = if selection.include_body {
            read_selected_bytes(&path, selection.start, selection.length).await?
        } else {
            Vec::new()
        };

        if selection.include_body {
            let after = tokio::fs::metadata(&path).await.map_err(|err| {
                FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true)
            })?;
            if content_identity(&after) != before_identity {
                return Err(FileOpenRejection::new(
                    "CONTENT_CHANGED",
                    "file content identity changed during read",
                    false,
                ));
            }
        }

        Ok(FileReadResponse {
            status_code: selection.status_code,
            headers,
            content_identity: before_identity,
            size: before.len(),
            body,
        })
    }

    async fn resolve_workspace_file(
        &self,
        frame: &FileOpenFrame,
    ) -> std::result::Result<PathBuf, FileOpenRejection> {
        let relative = validate_relative_path(&frame.relative_path)
            .map_err(|err| FileOpenRejection::new("UNSAFE_PATH", err.to_string(), false))?;
        let candidate = self.workspace_root.join(relative);
        let symlink_metadata = tokio::fs::symlink_metadata(&candidate)
            .await
            .map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    FileOpenRejection::new("FILE_NOT_FOUND", "file not found", false)
                } else {
                    FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true)
                }
            })?;
        if symlink_metadata.file_type().is_symlink() {
            return Err(FileOpenRejection::new(
                "SYMLINK_DENIED",
                "file path resolves to a symlink",
                false,
            ));
        }
        if !symlink_metadata.file_type().is_file() {
            return Err(FileOpenRejection::new(
                "UNSAFE_FILE_TYPE",
                "file path is not a regular file",
                false,
            ));
        }

        let canonical = tokio::fs::canonicalize(&candidate)
            .await
            .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
        if !canonical.starts_with(self.workspace_root.as_path()) {
            return Err(FileOpenRejection::new(
                "UNSAFE_PATH",
                "file path escapes the workspace root",
                false,
            ));
        }
        Ok(canonical)
    }

    async fn register_stream(
        &self,
        stream_id: String,
        sender: mpsc::UnboundedSender<FileStreamEvent>,
    ) {
        self.streams.lock().await.insert(stream_id, sender);
    }

    async fn unregister_stream(&self, stream_id: &str) {
        self.streams.lock().await.remove(stream_id);
    }
}

pub fn validate_file_open_frame(frame: &FileOpenFrame) -> Result<()> {
    if frame.stream_type != FILE_READ_STREAM_TYPE {
        bail!("unsupported file stream type: {}", frame.stream_type);
    }
    if frame.root_key != WORKSPACE_ROOT_KEY {
        bail!("unsupported file root: {}", frame.root_key);
    }
    validate_relative_path(&frame.relative_path)?;
    match frame.mode.as_str() {
        "stat" | "read" => {
            if frame.range_start.is_some()
                || frame.range_end.is_some()
                || frame.range_suffix_bytes.is_some()
            {
                bail!("non-range file mode must not include range fields");
            }
        }
        "range" => {
            if frame.range_suffix_bytes.is_some()
                && (frame.range_start.is_some() || frame.range_end.is_some())
            {
                bail!("suffix range must not include explicit start or end");
            }
            if frame.range_suffix_bytes.is_none() && frame.range_start.is_none() {
                bail!("range file mode requires range_start or range_suffix_bytes");
            }
        }
        other => bail!("unsupported file mode: {}", other),
    }
    Ok(())
}

fn validate_relative_path(input: &str) -> Result<PathBuf> {
    if input.is_empty() || input.starts_with('/') || input.starts_with('~') || input.contains('\0')
    {
        bail!("file path must be root-relative");
    }
    if input.contains('\\') {
        bail!("file path must use POSIX separators");
    }

    let mut output = PathBuf::new();
    for component in Path::new(input).components() {
        match component {
            Component::Normal(value) => output.push(value),
            Component::CurDir => {}
            Component::ParentDir => bail!("file path must not contain parent-directory segments"),
            Component::RootDir | Component::Prefix(_) => bail!("file path must be root-relative"),
        }
    }

    if output.as_os_str().is_empty() {
        bail!("file path must not be empty");
    }
    Ok(output)
}

struct FileSelection {
    status_code: u16,
    start: u64,
    length: u64,
    content_length: u64,
    content_range: Option<String>,
    include_body: bool,
}

fn select_file_bytes(
    frame: &FileOpenFrame,
    file_size: u64,
    max_bytes: u64,
) -> std::result::Result<FileSelection, FileOpenRejection> {
    match frame.mode.as_str() {
        "stat" => Ok(FileSelection {
            status_code: 200,
            start: 0,
            length: 0,
            content_length: file_size,
            content_range: None,
            include_body: false,
        }),
        "read" => {
            if file_size > max_bytes {
                return Err(FileOpenRejection::new(
                    "FILE_TOO_LARGE",
                    format!("file size {} exceeds max_bytes {}", file_size, max_bytes),
                    false,
                ));
            }
            Ok(FileSelection {
                status_code: 200,
                start: 0,
                length: file_size,
                content_length: file_size,
                content_range: None,
                include_body: true,
            })
        }
        "range" => select_range_bytes(frame, file_size, max_bytes),
        other => Err(FileOpenRejection::new(
            "POLICY_DENIED",
            format!("unsupported file mode: {}", other),
            false,
        )),
    }
}

fn select_range_bytes(
    frame: &FileOpenFrame,
    file_size: u64,
    max_bytes: u64,
) -> std::result::Result<FileSelection, FileOpenRejection> {
    if file_size == 0 {
        return Err(FileOpenRejection::new(
            "RANGE_NOT_SATISFIABLE",
            "cannot serve a byte range for an empty file",
            false,
        ));
    }

    let (start, end) = if let Some(suffix_bytes) = frame.range_suffix_bytes {
        if suffix_bytes == 0 {
            return Err(FileOpenRejection::new(
                "RANGE_NOT_SATISFIABLE",
                "suffix byte range must be positive",
                false,
            ));
        }
        let length = suffix_bytes.min(file_size);
        (file_size - length, file_size - 1)
    } else {
        let start = frame.range_start.unwrap_or(0);
        if start >= file_size {
            return Err(FileOpenRejection::new(
                "RANGE_NOT_SATISFIABLE",
                "range start is beyond end of file",
                false,
            ));
        }
        let end = frame.range_end.unwrap_or(file_size - 1).min(file_size - 1);
        if end < start {
            return Err(FileOpenRejection::new(
                "RANGE_NOT_SATISFIABLE",
                "range end is before range start",
                false,
            ));
        }
        (start, end)
    };

    let length = end - start + 1;
    if length > max_bytes {
        return Err(FileOpenRejection::new(
            "FILE_TOO_LARGE",
            format!("range size {} exceeds max_bytes {}", length, max_bytes),
            false,
        ));
    }

    Ok(FileSelection {
        status_code: 206,
        start,
        length,
        content_length: length,
        content_range: Some(format!("bytes {}-{}/{}", start, end, file_size)),
        include_body: true,
    })
}

async fn read_selected_bytes(
    path: &Path,
    start: u64,
    length: u64,
) -> std::result::Result<Vec<u8>, FileOpenRejection> {
    let length_usize: usize = length.try_into().map_err(|_| {
        FileOpenRejection::new(
            "FILE_TOO_LARGE",
            "file selection is too large for this daemon",
            false,
        )
    })?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
    }
    let mut body = vec![0_u8; length_usize];
    if length_usize > 0 {
        file.read_exact(&mut body)
            .await
            .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
    }
    Ok(body)
}

fn response_headers(
    file_size: u64,
    content_length: u64,
    content_identity: &Value,
) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    headers.insert("accept-ranges".into(), "bytes".into());
    headers.insert("content-length".into(), content_length.to_string());
    headers.insert("content-type".into(), "application/octet-stream".into());
    headers.insert("etag".into(), etag_for_identity(content_identity));
    headers.insert("x-bud-file-size".into(), file_size.to_string());
    headers
}

fn content_identity(metadata: &std::fs::Metadata) -> Value {
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    json!({
        "size": metadata.len(),
        "modified_ms": modified_ms,
    })
}

fn etag_for_identity(identity: &Value) -> String {
    let size = identity.get("size").and_then(Value::as_u64).unwrap_or(0);
    let modified_ms = identity
        .get("modified_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    format!("W/\"bud-{}-{}\"", size, modified_ms)
}

async fn wait_for_credit(
    available_credit: &mut u64,
    required: u64,
    credit_rx: &mut mpsc::UnboundedReceiver<FileStreamEvent>,
) -> Result<()> {
    while *available_credit < required {
        match credit_rx.recv().await {
            Some(FileStreamEvent::Credit { credit_bytes }) => {
                *available_credit = available_credit.saturating_add(credit_bytes);
            }
            Some(FileStreamEvent::Reset { reason }) => bail!("file stream reset: {}", reason),
            None => bail!("file stream credit channel closed"),
        }
    }
    Ok(())
}

fn send_file_open_accepted(
    sender: &TransportSender,
    frame: &FileOpenFrame,
    response: &FileReadResponse,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "file_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "stream_id": frame.stream_id,
            "accepted": true,
            "status_code": response.status_code,
            "headers": response.headers,
            "content_identity": response.content_identity,
            "size": response.size,
        }),
    )
}

fn send_file_open_rejected(
    sender: &TransportSender,
    frame: &FileOpenFrame,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "file_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "stream_id": frame.stream_id,
            "accepted": false,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable
            }
        }),
    )
}

fn send_stream_data(
    sender: &TransportSender,
    frame: &FileOpenFrame,
    offset: u64,
    data: &[u8],
    end_stream: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "stream_data",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "stream_id": frame.stream_id,
            "stream_type": frame.stream_type,
            "offset": offset,
            "data": BASE64_STANDARD.encode(data),
            "end_stream": end_stream,
        }),
    )
}

fn send_stream_close(sender: &TransportSender, stream_id: &str, final_offset: u64) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "stream_close",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "stream_id": stream_id,
            "final_offset": final_offset,
        }),
    )
}

impl FileOpenRejection {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::protocol::Envelope;

    use super::*;

    fn frame() -> FileOpenFrame {
        FileOpenFrame {
            envelope: Envelope {
                kind: "file_open".into(),
                proto: PROTO_VERSION.into(),
                id: "msg_test".into(),
                ts: 0,
                ext: Value::Null,
            },
            operation_id: "op_test".into(),
            stream_id: "st_test".into(),
            file_session_id: "fs_test".into(),
            stream_type: FILE_READ_STREAM_TYPE.into(),
            root_key: WORKSPACE_ROOT_KEY.into(),
            relative_path: "src/lib.rs".into(),
            mode: "read".into(),
            range_start: None,
            range_end: None,
            range_suffix_bytes: None,
            expected_content_identity: None,
            max_bytes: Some(1024),
            initial_credit_bytes: Some(1024),
            max_chunk_bytes: Some(16 * 1024),
        }
    }

    #[test]
    fn validates_workspace_read_policy() {
        assert!(validate_file_open_frame(&frame()).is_ok());

        let mut unsafe_path = frame();
        unsafe_path.relative_path = "../secrets".into();
        assert!(validate_file_open_frame(&unsafe_path).is_err());

        let mut unsupported_root = frame();
        unsupported_root.root_key = "home".into();
        assert!(validate_file_open_frame(&unsupported_root).is_err());

        let mut bad_range = frame();
        bad_range.mode = "range".into();
        assert!(validate_file_open_frame(&bad_range).is_err());
    }

    #[test]
    fn selects_single_byte_ranges() {
        let mut range = frame();
        range.mode = "range".into();
        range.range_start = Some(2);
        range.range_end = Some(4);

        let selection = select_file_bytes(&range, 10, 10).expect("range selection");
        assert_eq!(selection.status_code, 206);
        assert_eq!(selection.start, 2);
        assert_eq!(selection.length, 3);
        assert_eq!(selection.content_range.as_deref(), Some("bytes 2-4/10"));
    }

    #[test]
    fn enforces_max_bytes() {
        let result = select_file_bytes(&frame(), 2048, 1024);
        assert!(matches!(
            result,
            Err(FileOpenRejection {
                code: "FILE_TOO_LARGE",
                ..
            })
        ));
    }
}
