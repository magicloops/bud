use anyhow::{anyhow, bail, Context, Result};
use qrcodegen::{QrCode, QrCodeEcc};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

#[derive(Debug, Deserialize)]
pub struct DeviceAuthStartResponse {
    pub flow_id: String,
    pub claim_url: String,
    pub qr_payload: String,
    pub poll_secret: String,
    pub expires_at: String,
    pub poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct DeviceAuthPollResponse {
    pub status: String,
    pub bud_id: Option<String>,
    pub device_secret: Option<String>,
    pub expires_at: Option<String>,
    pub error_code: Option<String>,
    pub poll_interval_ms: Option<u64>,
}

pub async fn start_device_auth_flow(
    http_client: &Client,
    server_url: &str,
    installation_id: &str,
    name: &str,
    capabilities: Value,
    claim_id: Option<&str>,
) -> Result<DeviceAuthStartResponse> {
    let api_base = api_base_url_from_ws_url(server_url)?;
    let mut body = json!({
        "installation_id": installation_id,
        "name": name,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": capabilities,
    });
    if let Some(claim_id) = claim_id {
        body["claim_id"] = Value::String(claim_id.to_string());
    }

    let response = http_client
        .post(api_base.join("api/device-auth/start")?)
        .json(&body)
        .send()
        .await
        .with_context(|| "failed to start device auth flow")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!("device auth start failed (status={}): {}", status, body);
    }

    response
        .json::<DeviceAuthStartResponse>()
        .await
        .with_context(|| "failed to parse device auth start response")
}

pub async fn poll_device_auth_flow(
    http_client: &Client,
    server_url: &str,
    start: &DeviceAuthStartResponse,
) -> Result<DeviceAuthPollResponse> {
    let api_base = api_base_url_from_ws_url(server_url)?;
    let response = http_client
        .post(api_base.join("api/device-auth/poll")?)
        .json(&json!({
            "flow_id": start.flow_id,
            "poll_secret": start.poll_secret,
        }))
        .send()
        .await
        .with_context(|| "failed to poll device auth flow")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!("device auth poll failed (status={}): {}", status, body);
    }

    response
        .json::<DeviceAuthPollResponse>()
        .await
        .with_context(|| "failed to parse device auth poll response")
}

pub fn print_device_claim_instructions(start: &DeviceAuthStartResponse) {
    println!();
    println!("Bud needs browser approval before it can connect.");
    println!("Open this link on a signed-in browser:");
    println!("{}", start.claim_url);
    println!();
    println!(
        "Claim expires at {}. Waiting for browser approval...",
        start.expires_at
    );
    println!();
    if print_terminal_qr(&start.qr_payload).is_err() {
        println!("QR rendering failed. Open the claim URL above instead.");
    }
    println!();
}

fn print_terminal_qr(payload: &str) -> Result<()> {
    let qr = QrCode::encode_text(payload, QrCodeEcc::Medium)
        .map_err(|_| anyhow!("failed to encode QR payload"))?;
    let size = qr.size();
    let border = 2;
    let mut y = -border;
    while y < size + border {
        let mut line = String::new();
        for x in -border..(size + border) {
            let top = qr_module(&qr, x, y);
            let bottom = qr_module(&qr, x, y + 1);
            let ch = match (top, bottom) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            };
            line.push(ch);
            line.push(ch);
        }
        println!("{}", line);
        y += 2;
    }
    Ok(())
}

fn qr_module(qr: &QrCode, x: i32, y: i32) -> bool {
    x >= 0 && y >= 0 && x < qr.size() && y < qr.size() && qr.get_module(x, y)
}

pub(crate) fn api_base_url_from_ws_url(ws_url: &str) -> Result<Url> {
    let mut url = Url::parse(ws_url)?;
    match url.scheme() {
        "wss" => url
            .set_scheme("https")
            .map_err(|_| anyhow!("failed to convert wss URL to https"))?,
        "ws" => url
            .set_scheme("http")
            .map_err(|_| anyhow!("failed to convert ws URL to http"))?,
        "https" | "http" => {}
        other => bail!("unsupported server URL scheme: {}", other),
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}
