//! One requested agent image, independent of the human viewer media stream.
use anyhow::{bail, Result};
use serde_json::Value;
use std::time::Duration;
pub(super) async fn upload(endpoint: &str, ticket: &str, frame: &Value) -> Result<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(endpoint)
        .bearer_auth(ticket)
        .json(frame)
        .send()
        .await?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 4096) {
        bail!("browser_capture_rejected");
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 4096 {
            bail!("browser_capture_rejected");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
