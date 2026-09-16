# src

Rust host for the disposable managed-browser experiment.

- `lib.rs`: owned ephemeral Chromium launch, bounded semantic snapshots and
  references, target inventory, focus-guarded input, private takeover/return,
  demand JPEG capture and scoped child cleanup. Launch proves responsiveness
  with a target-inventory round trip, not just the DevTools handshake; failed
  startup preserves its cause and reaps the owned child. Discovery waits through
  incomplete `DevToolsActivePort` writes; its parser has truncated-write tests.
  Disposable profiles use mock/basic credential storage to avoid OS Keychain
  prompts. That is not the security policy for future persistent profiles.
- `control.rs`: serial epoch admission and one-controller lease state; private
  observation gating, paused expiry and fresh-observation return barrier.
- `cdp.rs`: private, serial CDP socket with bounded incoming messages, command
  timeout and channel poisoning on cancellation/unknown outcome. Never exposed
  as a relay method dispatcher. Timeout errors contain bounded method/ID,
  send timing and received-frame counts, never command parameters or page data.
- `main.rs`: typed command host with separate outbound control/media sockets;
  short-lived bearer tickets from environment and no payload logging.

Tokio/tungstenite carry CDP and relay connections, serde handles the narrow
prototype envelope, tempfile owns ephemeral profiles, base64 decodes capture.
Production daemon adapters, event-driven invalidation, priority revocation,
persistent profiles and reconnect reconciliation remain outside this spike.
