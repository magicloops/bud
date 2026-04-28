use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tracing::warn;

const JOURNAL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct DaemonJournal {
    pub version: u32,
    #[serde(default)]
    pub accepted_operations: Vec<JournalOperation>,
    #[serde(default)]
    pub active_streams: Vec<JournalStream>,
    #[serde(default)]
    pub terminal_sessions: Vec<String>,
    #[serde(default)]
    pub local_policy_version: Option<String>,
}

impl Default for DaemonJournal {
    fn default() -> Self {
        Self {
            version: JOURNAL_VERSION,
            accepted_operations: Vec::new(),
            active_streams: Vec::new(),
            terminal_sessions: Vec::new(),
            local_policy_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct JournalOperation {
    pub operation_id: String,
    pub state: String,
    #[serde(default)]
    pub operation_type: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct JournalStream {
    pub stream_id: String,
    #[serde(default)]
    pub operation_id: Option<String>,
    pub stream_type: String,
    pub state: String,
    #[serde(default)]
    pub send_offset: u64,
    #[serde(default)]
    pub receive_offset: u64,
    #[serde(default)]
    pub updated_at: Option<String>,
}

pub async fn load_journal(path: &Path) -> Result<DaemonJournal> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DaemonJournal::default());
        }
        Err(err) => return Err(err.into()),
    };

    match serde_json::from_slice::<DaemonJournal>(&bytes) {
        Ok(mut journal) => {
            if journal.version == 0 {
                journal.version = JOURNAL_VERSION;
            }
            Ok(journal)
        }
        Err(err) => {
            warn!(
                path = %path.display(),
                error = %err,
                "daemon journal is unreadable; starting with empty reconciliation state"
            );
            Ok(DaemonJournal::default())
        }
    }
}

pub async fn save_journal(path: &Path, journal: &DaemonJournal) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut normalized = journal.clone();
    normalized.version = JOURNAL_VERSION;
    let bytes = serde_json::to_vec_pretty(&normalized)?;
    fs::write(path, bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ulid::Ulid;

    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bud-journal-{}-{name}.json", Ulid::new()))
    }

    #[tokio::test]
    async fn journal_round_trips() {
        let path = temp_path("roundtrip");
        let journal = DaemonJournal {
            accepted_operations: vec![JournalOperation {
                operation_id: "op_1".to_string(),
                state: "running".to_string(),
                operation_type: Some("terminal_send".to_string()),
                updated_at: None,
            }],
            active_streams: vec![JournalStream {
                stream_id: "st_1".to_string(),
                operation_id: Some("op_1".to_string()),
                stream_type: "terminal_interactive".to_string(),
                state: "open".to_string(),
                send_offset: 7,
                receive_offset: 9,
                updated_at: None,
            }],
            terminal_sessions: vec!["sess_1".to_string()],
            local_policy_version: Some("local".to_string()),
            ..DaemonJournal::default()
        };

        save_journal(&path, &journal).await.expect("save journal");
        let loaded = load_journal(&path).await.expect("load journal");

        assert_eq!(loaded, journal);
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn missing_or_corrupt_journal_loads_as_empty() {
        let missing = load_journal(&temp_path("missing"))
            .await
            .expect("missing journal");
        assert_eq!(missing, DaemonJournal::default());

        let corrupt_path = temp_path("corrupt");
        fs::write(&corrupt_path, b"not json")
            .await
            .expect("write corrupt");
        let corrupt = load_journal(&corrupt_path).await.expect("corrupt journal");
        assert_eq!(corrupt, DaemonJournal::default());
        let _ = fs::remove_file(corrupt_path).await;
    }
}
