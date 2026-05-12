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

use crate::protocol::{
    FileOpenFrame, FileResolveFrame, StreamCreditFrame, StreamResetFrame, PROTO_VERSION,
};
use crate::transport::{send_transport_frame, TransportSender};
use crate::util::{new_message_id, now_millis};

const FILE_READ_STREAM_TYPE: &str = "file_read";
const WORKSPACE_ROOT_KEY: &str = "workspace";
const DEFAULT_INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES: usize = 16 * 1024;
const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES_LIMIT: usize = 1024 * 1024;
const RESOLVED_AGAINST_MESSAGE_CWD: &str = "message_cwd";
const RESOLVED_AGAINST_TERMINAL_CWD: &str = "terminal_cwd";
const RESOLVED_AGAINST_WORKSPACE: &str = "workspace";
const RESOLVED_AGAINST_ABSOLUTE_PATH: &str = "absolute_path";

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
    resolved_against: &'static str,
    resolved_relative_path: String,
    size: u64,
    body: Vec<u8>,
}

struct FileResolveResponse {
    root_key: &'static str,
    requested_path_kind: &'static str,
    content_identity: Value,
    resolved_against: &'static str,
    resolved_relative_path: String,
    size: u64,
}

struct ResolvedFile {
    path: PathBuf,
    resolved_against: &'static str,
    resolved_relative_path: String,
}

struct FileCandidate {
    path: PathBuf,
    resolved_against: &'static str,
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

    pub fn handle_open(
        &self,
        frame: FileOpenFrame,
        sender: TransportSender,
        terminal_cwd: Option<String>,
    ) {
        let manager = self.clone();
        task::spawn_local(async move {
            if let Err(err) = manager.run_file(frame, sender, terminal_cwd).await {
                warn!(error = %err, "file read stream task failed");
            }
        });
    }

    pub fn handle_resolve(&self, frame: FileResolveFrame, sender: TransportSender) {
        let manager = self.clone();
        task::spawn_local(async move {
            if let Err(err) = manager.run_file_resolve(frame, sender).await {
                warn!(error = %err, "file resolve task failed");
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

    async fn run_file(
        &self,
        frame: FileOpenFrame,
        sender: TransportSender,
        terminal_cwd: Option<String>,
    ) -> Result<()> {
        if let Err(err) = validate_file_open_frame(&frame) {
            send_file_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }

        let (credit_tx, mut credit_rx) = mpsc::unbounded_channel();
        self.register_stream(frame.stream_id.clone(), credit_tx)
            .await;

        let result = self
            .run_validated_file(
                frame.clone(),
                sender.clone(),
                terminal_cwd.as_deref(),
                &mut credit_rx,
            )
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

    async fn run_file_resolve(
        &self,
        frame: FileResolveFrame,
        sender: TransportSender,
    ) -> Result<()> {
        if let Err(err) = validate_file_resolve_frame(&frame) {
            send_file_resolve_rejected(&sender, &frame, "UNSAFE_PATH", &err.to_string(), false)?;
            return Ok(());
        }

        match self.resolve_absolute_file(&frame).await {
            Ok(response) => send_file_resolve_accepted(&sender, &frame, &response)?,
            Err(rejection) => send_file_resolve_rejected(
                &sender,
                &frame,
                rejection.code,
                &rejection.message,
                rejection.retryable,
            )?,
        }
        Ok(())
    }

    async fn run_validated_file(
        &self,
        frame: FileOpenFrame,
        sender: TransportSender,
        terminal_cwd: Option<&str>,
        credit_rx: &mut mpsc::UnboundedReceiver<FileStreamEvent>,
    ) -> Result<()> {
        let response = match self.read_file_response(&frame, terminal_cwd).await {
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
        terminal_cwd: Option<&str>,
    ) -> std::result::Result<FileReadResponse, FileOpenRejection> {
        let max_bytes = frame.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
        let resolved = self.resolve_file(frame, terminal_cwd).await?;
        let before = tokio::fs::metadata(&resolved.path)
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
            read_selected_bytes(&resolved.path, selection.start, selection.length).await?
        } else {
            Vec::new()
        };

        if selection.include_body {
            let after = tokio::fs::metadata(&resolved.path).await.map_err(|err| {
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
            resolved_against: resolved.resolved_against,
            resolved_relative_path: resolved.resolved_relative_path,
            size: before.len(),
            body,
        })
    }

    async fn resolve_file(
        &self,
        frame: &FileOpenFrame,
        terminal_cwd: Option<&str>,
    ) -> std::result::Result<ResolvedFile, FileOpenRejection> {
        let relative = validate_relative_path(&frame.relative_path)
            .map_err(|err| FileOpenRejection::new("UNSAFE_PATH", err.to_string(), false))?;

        let has_message_cwd_hint = frame
            .resolution_hint
            .as_ref()
            .is_some_and(|hint| hint.kind == "host_cwd");

        let mut candidates = Vec::with_capacity(2);
        if has_message_cwd_hint {
            if let Some(candidate) = self.message_cwd_candidate(frame, &relative).await {
                candidates.push(candidate);
            }
        } else if let Some(candidate) = self
            .cwd_candidate(terminal_cwd, &relative, RESOLVED_AGAINST_TERMINAL_CWD)
            .await
        {
            candidates.push(candidate);
        }
        candidates.push(FileCandidate {
            path: self.workspace_root.join(&relative),
            resolved_against: RESOLVED_AGAINST_WORKSPACE,
        });

        let mut last_not_found: Option<FileOpenRejection> = None;
        for candidate in candidates {
            match self.resolve_candidate(candidate).await {
                Ok(resolved) => return Ok(resolved),
                Err(rejection) if rejection.code == "FILE_NOT_FOUND" => {
                    last_not_found = Some(rejection);
                }
                Err(rejection) => return Err(rejection),
            }
        }

        Err(last_not_found
            .unwrap_or_else(|| FileOpenRejection::new("FILE_NOT_FOUND", "file not found", false)))
    }

    async fn resolve_absolute_file(
        &self,
        frame: &FileResolveFrame,
    ) -> std::result::Result<FileResolveResponse, FileOpenRejection> {
        let candidate_path = validate_absolute_posix_path(&frame.requested_path)
            .map_err(|err| FileOpenRejection::new("UNSAFE_PATH", err.to_string(), false))?;
        if !candidate_path.starts_with(self.workspace_root.as_path()) {
            return Err(FileOpenRejection::new(
                "POLICY_DENIED",
                "path is outside the Bud file-viewer scope",
                false,
            ));
        }

        let resolved = self
            .resolve_candidate(FileCandidate {
                path: candidate_path,
                resolved_against: RESOLVED_AGAINST_ABSOLUTE_PATH,
            })
            .await?;
        let metadata = tokio::fs::metadata(&resolved.path)
            .await
            .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
        Ok(FileResolveResponse {
            root_key: WORKSPACE_ROOT_KEY,
            requested_path_kind: "absolute_posix",
            content_identity: content_identity(&metadata),
            resolved_against: resolved.resolved_against,
            resolved_relative_path: resolved.resolved_relative_path,
            size: metadata.len(),
        })
    }

    async fn message_cwd_candidate(
        &self,
        frame: &FileOpenFrame,
        relative: &Path,
    ) -> Option<FileCandidate> {
        let hint = frame.resolution_hint.as_ref()?;
        self.cwd_candidate(
            hint.host_cwd.as_deref(),
            relative,
            RESOLVED_AGAINST_MESSAGE_CWD,
        )
        .await
    }

    async fn cwd_candidate(
        &self,
        cwd: Option<&str>,
        relative: &Path,
        resolved_against: &'static str,
    ) -> Option<FileCandidate> {
        let cwd = cwd?;
        let cwd_path = PathBuf::from(cwd);
        if !cwd_path.is_absolute() {
            return None;
        }
        let canonical_cwd = tokio::fs::canonicalize(cwd_path).await.ok()?;
        if !canonical_cwd.starts_with(self.workspace_root.as_path()) {
            return None;
        }
        Some(FileCandidate {
            path: canonical_cwd.join(relative),
            resolved_against,
        })
    }

    async fn resolve_candidate(
        &self,
        candidate: FileCandidate,
    ) -> std::result::Result<ResolvedFile, FileOpenRejection> {
        let symlink_metadata =
            tokio::fs::symlink_metadata(&candidate.path)
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

        let canonical = tokio::fs::canonicalize(&candidate.path)
            .await
            .map_err(|err| FileOpenRejection::new("LOCAL_READ_FAILED", err.to_string(), true))?;
        if !canonical.starts_with(self.workspace_root.as_path()) {
            return Err(FileOpenRejection::new(
                "UNSAFE_PATH",
                "file path escapes the workspace root",
                false,
            ));
        }
        let resolved_relative_path = self.workspace_relative_path(&canonical)?;
        Ok(ResolvedFile {
            path: canonical,
            resolved_against: candidate.resolved_against,
            resolved_relative_path,
        })
    }

    fn workspace_relative_path(
        &self,
        path: &Path,
    ) -> std::result::Result<String, FileOpenRejection> {
        let relative = path
            .strip_prefix(self.workspace_root.as_path())
            .map_err(|_| {
                FileOpenRejection::new("UNSAFE_PATH", "file path escapes the workspace root", false)
            })?;
        let normalized = path_to_posix_string(relative);
        if normalized.is_empty() {
            return Err(FileOpenRejection::new(
                "UNSAFE_FILE_TYPE",
                "file path is not a regular file",
                false,
            ));
        }
        Ok(normalized)
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

pub fn validate_file_resolve_frame(frame: &FileResolveFrame) -> Result<()> {
    if frame.root_key != WORKSPACE_ROOT_KEY {
        bail!("unsupported file root: {}", frame.root_key);
    }
    if frame.requested_path_kind != "absolute_posix" {
        bail!(
            "unsupported requested path kind: {}",
            frame.requested_path_kind
        );
    }
    validate_absolute_posix_path(&frame.requested_path)?;
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

fn validate_absolute_posix_path(input: &str) -> Result<PathBuf> {
    if input.is_empty() || input.contains('\0') {
        bail!("file path must not be empty or contain NUL bytes");
    }
    if input.starts_with("~") {
        bail!("home-relative file paths are not supported");
    }
    if input.contains('\\') {
        bail!("file path must use POSIX separators");
    }
    if input.ends_with('/') {
        bail!("directory paths are not supported");
    }
    if is_url_like_path(input) || is_windows_drive_path(input) {
        bail!("unsupported file path syntax");
    }
    if !input.starts_with('/') {
        bail!("file path must be absolute POSIX syntax");
    }

    let mut output = PathBuf::from("/");
    for component in Path::new(input).components() {
        match component {
            Component::RootDir => {}
            Component::CurDir => {}
            Component::Normal(value) => output.push(value),
            Component::ParentDir => {
                output.pop();
                if output.as_os_str().is_empty() {
                    output.push("/");
                }
            }
            Component::Prefix(_) => bail!("file path must use POSIX separators"),
        }
    }

    if output == PathBuf::from("/") {
        bail!("file path must point to a file");
    }
    Ok(output)
}

fn is_url_like_path(input: &str) -> bool {
    input
        .find(':')
        .is_some_and(|index| input[..index].contains(|ch: char| ch.is_ascii_alphabetic()))
        && (input.contains("://") || input.to_ascii_lowercase().starts_with("mailto:"))
}

fn is_windows_drive_path(input: &str) -> bool {
    let bytes = input.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn path_to_posix_string(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        if let Component::Normal(value) = component {
            parts.push(value.to_string_lossy().into_owned());
        }
    }
    parts.join("/")
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
            "resolved_against": response.resolved_against,
            "resolved_relative_path": response.resolved_relative_path,
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

fn send_file_resolve_accepted(
    sender: &TransportSender,
    frame: &FileResolveFrame,
    response: &FileResolveResponse,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "file_resolve_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "accepted": true,
            "root_key": response.root_key,
            "requested_path_kind": response.requested_path_kind,
            "resolved_against": response.resolved_against,
            "resolved_relative_path": response.resolved_relative_path,
            "content_identity": response.content_identity,
            "size": response.size,
        }),
    )
}

fn send_file_resolve_rejected(
    sender: &TransportSender,
    frame: &FileResolveFrame,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "file_resolve_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
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
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::protocol::{Envelope, FileOpenResolutionHint};

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
            terminal_session_id: None,
            stream_type: FILE_READ_STREAM_TYPE.into(),
            root_key: WORKSPACE_ROOT_KEY.into(),
            relative_path: "src/lib.rs".into(),
            resolution_hint: None,
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

    fn resolve_frame(path: String) -> FileResolveFrame {
        FileResolveFrame {
            envelope: Envelope {
                kind: "file_resolve".into(),
                proto: PROTO_VERSION.into(),
                id: "msg_resolve_test".into(),
                ts: 0,
                ext: Value::Null,
            },
            operation_id: "op_resolve_test".into(),
            root_key: WORKSPACE_ROOT_KEY.into(),
            requested_path: path,
            requested_path_kind: "absolute_posix".into(),
            max_bytes: Some(1024),
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
    fn validates_absolute_file_resolve_policy() {
        let workspace = temp_workspace("absolute-policy");
        let frame = resolve_frame(workspace.join("src/lib.rs").to_string_lossy().into_owned());
        assert!(validate_file_resolve_frame(&frame).is_ok());

        let mut unsupported_kind = frame.clone();
        unsupported_kind.requested_path_kind = "relative".into();
        assert!(validate_file_resolve_frame(&unsupported_kind).is_err());

        let mut relative = frame.clone();
        relative.requested_path = "src/lib.rs".into();
        assert!(validate_file_resolve_frame(&relative).is_err());

        let mut windows = frame.clone();
        windows.requested_path = "C:/Users/adam/file.txt".into();
        assert!(validate_file_resolve_frame(&windows).is_err());

        let mut url = frame;
        url.requested_path = "https://example.com/file.ts".into();
        assert!(validate_file_resolve_frame(&url).is_err());
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn resolves_absolute_posix_file_under_workspace() {
        let workspace = temp_workspace("absolute-under-root");
        let target = workspace.join("docs/proto.md");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"hello").unwrap();

        let manager = FileManager::new(workspace.clone());
        let response = manager
            .resolve_absolute_file(&resolve_frame(target.to_string_lossy().into_owned()))
            .await
            .expect("resolve response");

        assert_eq!(response.root_key, WORKSPACE_ROOT_KEY);
        assert_eq!(response.requested_path_kind, "absolute_posix");
        assert_eq!(response.resolved_against, RESOLVED_AGAINST_ABSOLUTE_PATH);
        assert_eq!(response.resolved_relative_path, "docs/proto.md");
        assert_eq!(response.size, 5);
        assert_eq!(
            response
                .content_identity
                .get("size")
                .and_then(Value::as_u64),
            Some(5)
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn rejects_absolute_posix_file_outside_workspace() {
        let workspace = temp_workspace("absolute-outside-root");
        let outside = temp_workspace("absolute-outside-target");
        let target = outside.join("secret.txt");
        fs::write(&target, b"secret").unwrap();

        let manager = FileManager::new(workspace.clone());
        let result = manager
            .resolve_absolute_file(&resolve_frame(target.to_string_lossy().into_owned()))
            .await;

        assert!(matches!(
            result,
            Err(FileOpenRejection {
                code: "POLICY_DENIED",
                ..
            })
        ));
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn rejects_absolute_directory_and_symlink() {
        let workspace = temp_workspace("absolute-unsafe-types");
        let directory = workspace.join("docs");
        let real_file = workspace.join("real.md");
        let symlink = workspace.join("link.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&real_file, b"real").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_file, &symlink).unwrap();

        let manager = FileManager::new(workspace.clone());
        let directory_result = manager
            .resolve_absolute_file(&resolve_frame(directory.to_string_lossy().into_owned()))
            .await;
        assert!(matches!(
            directory_result,
            Err(FileOpenRejection {
                code: "UNSAFE_FILE_TYPE",
                ..
            })
        ));

        #[cfg(unix)]
        {
            let symlink_result = manager
                .resolve_absolute_file(&resolve_frame(symlink.to_string_lossy().into_owned()))
                .await;
            assert!(matches!(
                symlink_result,
                Err(FileOpenRejection {
                    code: "SYMLINK_DENIED",
                    ..
                })
            ));
        }
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn resolves_terminal_cwd_before_workspace_root() {
        let workspace = temp_workspace("cwd-first");
        let workspace_file = workspace.join("src/lib.rs");
        let cwd_file = workspace.join("service/src/lib.rs");
        fs::create_dir_all(workspace_file.parent().unwrap()).unwrap();
        fs::create_dir_all(cwd_file.parent().unwrap()).unwrap();
        fs::write(&workspace_file, b"workspace").unwrap();
        fs::write(&cwd_file, b"cwd").unwrap();

        let manager = FileManager::new(workspace.clone());
        let terminal_cwd = workspace.join("service").to_string_lossy().into_owned();
        let response = manager
            .read_file_response(&frame(), Some(&terminal_cwd))
            .await
            .expect("read response");

        assert_eq!(response.resolved_against, RESOLVED_AGAINST_TERMINAL_CWD);
        assert_eq!(response.resolved_relative_path, "service/src/lib.rs");
        assert_eq!(response.body.as_slice(), b"cwd");
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn resolves_message_cwd_before_terminal_cwd_and_workspace_root() {
        let workspace = temp_workspace("message-cwd-first");
        let workspace_file = workspace.join("src/lib.rs");
        let message_cwd_file = workspace.join("service/src/lib.rs");
        let terminal_cwd_file = workspace.join("web/src/lib.rs");
        fs::create_dir_all(workspace_file.parent().unwrap()).unwrap();
        fs::create_dir_all(message_cwd_file.parent().unwrap()).unwrap();
        fs::create_dir_all(terminal_cwd_file.parent().unwrap()).unwrap();
        fs::write(&workspace_file, b"workspace").unwrap();
        fs::write(&message_cwd_file, b"message").unwrap();
        fs::write(&terminal_cwd_file, b"terminal").unwrap();

        let manager = FileManager::new(workspace.clone());
        let mut hinted_frame = frame();
        hinted_frame.resolution_hint = Some(FileOpenResolutionHint {
            kind: "host_cwd".into(),
            host_cwd: Some(workspace.join("service").to_string_lossy().into_owned()),
            source_message_id: Some("22222222-2222-4222-8222-222222222222".into()),
        });
        let terminal_cwd = workspace.join("web").to_string_lossy().into_owned();
        let response = manager
            .read_file_response(&hinted_frame, Some(&terminal_cwd))
            .await
            .expect("read response");

        assert_eq!(response.resolved_against, RESOLVED_AGAINST_MESSAGE_CWD);
        assert_eq!(response.resolved_relative_path, "service/src/lib.rs");
        assert_eq!(response.body.as_slice(), b"message");
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn message_cwd_hint_skips_terminal_cwd_when_hint_is_outside_workspace() {
        let workspace = temp_workspace("message-cwd-outside");
        let outside = temp_workspace("message-cwd-outside-root");
        let workspace_file = workspace.join("src/lib.rs");
        let terminal_cwd_file = workspace.join("service/src/lib.rs");
        let outside_file = outside.join("src/lib.rs");
        fs::create_dir_all(workspace_file.parent().unwrap()).unwrap();
        fs::create_dir_all(terminal_cwd_file.parent().unwrap()).unwrap();
        fs::create_dir_all(outside_file.parent().unwrap()).unwrap();
        fs::write(&workspace_file, b"workspace").unwrap();
        fs::write(&terminal_cwd_file, b"terminal").unwrap();
        fs::write(&outside_file, b"outside").unwrap();

        let manager = FileManager::new(workspace.clone());
        let mut hinted_frame = frame();
        hinted_frame.resolution_hint = Some(FileOpenResolutionHint {
            kind: "host_cwd".into(),
            host_cwd: Some(outside.to_string_lossy().into_owned()),
            source_message_id: None,
        });
        let terminal_cwd = workspace.join("service").to_string_lossy().into_owned();
        let response = manager
            .read_file_response(&hinted_frame, Some(&terminal_cwd))
            .await
            .expect("read response");

        assert_eq!(response.resolved_against, RESOLVED_AGAINST_WORKSPACE);
        assert_eq!(response.resolved_relative_path, "src/lib.rs");
        assert_eq!(response.body.as_slice(), b"workspace");
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn resolves_workspace_root_without_terminal_cwd() {
        let workspace = temp_workspace("no-terminal-cwd");
        let workspace_file = workspace.join("src/lib.rs");
        fs::create_dir_all(workspace_file.parent().unwrap()).unwrap();
        fs::write(&workspace_file, b"workspace").unwrap();

        let manager = FileManager::new(workspace.clone());
        let response = manager
            .read_file_response(&frame(), None)
            .await
            .expect("read response");

        assert_eq!(response.resolved_against, RESOLVED_AGAINST_WORKSPACE);
        assert_eq!(response.resolved_relative_path, "src/lib.rs");
        assert_eq!(response.body.as_slice(), b"workspace");
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn falls_back_to_workspace_root_when_terminal_cwd_file_is_missing() {
        let workspace = temp_workspace("cwd-missing");
        let workspace_file = workspace.join("src/lib.rs");
        fs::create_dir_all(workspace.join("service")).unwrap();
        fs::create_dir_all(workspace_file.parent().unwrap()).unwrap();
        fs::write(&workspace_file, b"workspace").unwrap();

        let manager = FileManager::new(workspace.clone());
        let terminal_cwd = workspace.join("service").to_string_lossy().into_owned();
        let response = manager
            .read_file_response(&frame(), Some(&terminal_cwd))
            .await
            .expect("read response");

        assert_eq!(response.resolved_against, RESOLVED_AGAINST_WORKSPACE);
        assert_eq!(response.resolved_relative_path, "src/lib.rs");
        assert_eq!(response.body.as_slice(), b"workspace");
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test]
    async fn ignores_terminal_cwd_outside_workspace_root() {
        let workspace = temp_workspace("cwd-outside-workspace");
        let outside = temp_workspace("cwd-outside");
        let workspace_file = workspace.join("src/lib.rs");
        let outside_file = outside.join("src/lib.rs");
        fs::create_dir_all(workspace_file.parent().unwrap()).unwrap();
        fs::create_dir_all(outside_file.parent().unwrap()).unwrap();
        fs::write(&workspace_file, b"workspace").unwrap();
        fs::write(&outside_file, b"outside").unwrap();

        let manager = FileManager::new(workspace.clone());
        let terminal_cwd = outside.to_string_lossy().into_owned();
        let response = manager
            .read_file_response(&frame(), Some(&terminal_cwd))
            .await
            .expect("read response");

        assert_eq!(response.resolved_against, RESOLVED_AGAINST_WORKSPACE);
        assert_eq!(response.resolved_relative_path, "src/lib.rs");
        assert_eq!(response.body.as_slice(), b"workspace");
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
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

    fn temp_workspace(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "bud-file-manager-test-{}-{}-{}",
            name,
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&path).unwrap();
        fs::canonicalize(path).unwrap()
    }
}
