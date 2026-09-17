# Debug: Reddit clicks and viewer disconnects

## Environment and reproduction

Visible Chrome controlled by the local daemon, localhost HTTPS service and web viewer.
Thread `00aac56c-7e03-47d5-a4f7-fb380bf2c2dd`; browser
`browser_01M2PC8M6GHN26JW31VRTP0HGT`. September 17, 2026,
00:28–00:34 UTC. Agent browsed HN, then Reddit. User saw the pane disconnect
while the native Chrome window stayed open. Challenge disappearance has no
established cause; it is not evidence of successful fingerprint validation.

## Evidence

Read persisted browser tool results and local service lifecycle logs
(`/tmp/bud-local-web-https.log`, pretty-printed local timestamps, UTC minus seven).
No runtime changes made during this investigation.

### Clicks

Reddit snapshots succeeded and exposed the requested story titles and link
references. At 00:32:09 and 00:32:20 the agent clicked the same observed link
for “Once the cop heard dash cam he knew he messed up”. At 00:32:43 it clicked
a different story link. All three returned `browser_outcome_unknown` after
approximately 3 seconds. Subsequent page_info still reported the Reddit root.
Direct navigation to story URLs later succeeded.

The helper uses `ElementHandle.click({ timeout: 3000 })`. Its outer catch maps
noncanonical errors to `browser_outcome_unknown`, discarding Playwright detail.
The duration strongly suggests click timeout, but stored results cannot establish
whether actionability, interception, detachment, or navigation waiting caused it.
Successful snapshot/visible_dom calls also took approximately 3 seconds; these
have their own 3000ms snapshot timeout and must not be counted as click failures.
The agent explanation that client rendering itself prevents clicking is unproven.

### Viewer

Service media closure records correlate with the daemon excerpt:

| UTC | Service closure reason | Observation |
|---|---|---|
| 00:30:05 | daemon_closed | browser_open succeeds; epoch advances 2 to 3 |
| 00:31:38 | daemon_closed | navigation succeeds; epoch advances 3 to 4 |
| 00:31:55 | daemon_closed | navigation succeeds; epoch advances 4 to 5 |
| 00:32:12 | last_viewer_closed | same epoch 5, 15.0s media lifetime |
| 00:32:21 | last_viewer_closed | same epoch 5, 6.0s media lifetime |
| 00:32:45 | last_viewer_closed | same epoch 5, 15.0s media lifetime |

These are media connections ending, not proof of Chrome or the main daemon
connection dying. The same browser session continues serving operations. The
first three correlate with authority epochs changing; later closures originate
from loss/closure of the last viewer. Web console also reports simultaneous
agent and terminal SSE ERR_NETWORK_CHANGED recovery. That is consistent with
transport disruption, but untimestamped console output cannot correlate each
media closure or establish why the network-change events occur.

`BrowserCanvas` clears its frame/canvas on every socket close/error/revocation,
then reports unavailable. This explains why a transport interruption can visibly
blank a still-running browser. Daemon media currently discards the underlying
error and logs generic media_ended, so receive_demand alone does not distinguish
revocation, timeout, peer closure or transport error.

## Next steps

1. Add bounded, sanitized click failure diagnostics: operation, timeout stage,
   and known error categories; avoid raw page text, field values or unrestricted
   Playwright error strings. Reproduce the observed link and compare actual hit
   target/actionability before changing click semantics. Do not force-click.
2. Trace media closure origin and authority transitions with safe reason codes.
   Distinguish transient transport loss from revoked authorization in the viewer.
   Any retained last frame must be explicitly stale, noninteractive, and cleared
   on privacy/ownership/session changes; never retain blindly across revocation.
3. Correlate timestamped browser socket closure with SSE network errors before
   changing transport timeouts. The evidence does not justify increasing leases
   or restarting Chrome.

## Relevant files

- `bud/browser-helper/engine.mjs` and `main.mjs`: click and error mapping.
- `bud/src/browser/media.rs`: daemon media loop and end logging.
- `service/src/browser/media.ts`: lifecycle reasons and viewer membership.
- `web/src/features/browser/media.ts`: canvas clearing on disconnection.

No fix or CAPTCHA behavior claim is established by this note.

## Instrumentation for next reproduction

Daemon: `browser_timing` / `semantic_failure` reports the failed helper stage and boolean timeout/interception/visibility/stability/detachment/navigation-wait signals. These are error-message hints, not proof that a click was dispatched. Correlate daemon timestamps with the existing session/request page_operation log. `browser_media` endings now report typed reason and numeric peer close code.

Web: Vite dev console `browser-media` entries include UTC timestamp, connection-local identity, first frame and closure origin, plus frame age/count. Service existing media_closed logs complete the correlation. No capture cadence, timeout, retry, click or privacy behavior changed. Private helper diagnostics are stripped at Rust; no service wire contract changes.

Restart the daemon with the same headed Chrome configuration, refresh the local web app, and preserve console logs while repeating the flow. Capture daemon output and web console with the next thread ID. No extra environment flags are required.

Validation: initial `cargo check --manifest-path bud/Cargo.toml` hit E0502 at semantic.rs because the kill-on-cancel guard retained the mutable child borrow while logging its PID. Read the PID through that same guard; no lifetime or cancellation behavior changed.

## Instrumented run: 918cfc7f-18c9-4315-8e5f-83d848a5a748

September 17, 00:47–00:50 UTC; user reported no noticeable viewer disconnect.
Persisted tool results and service lifecycle records correlated with provided logs:

- 00:47:29 snapshot failed with browser_document_changed, then a fresh snapshot
  succeeded at 00:47:30. This was a navigation race, not a click failure.
- 00:48:09 story-title click timed out after 3037ms with intercepted=true;
  navigation_wait=false, target_closed=false. The observed title link existed,
  but Playwright reported pointer interception. Identity of the intercepting
  element remains unknown; do not infer CAPTCHA, modal, or client-rendering failure.
- Later external-source link click completed, but page_info still showed root
  (completion alone does not establish navigation). A later Reddit comments-link
  click completed and page_info confirmed the comments URL at 00:49:06.
- Media authority was revoked at 00:47:56 (epoch 2 to 3) and 00:49:00 (3 to 4).
  These coincide with first browser work after follow-up user messages at
  00:47:53 and 00:48:55 respectively. Both service records say daemon_closed.
  No browser crash or media timeout is reported in this excerpt.
- First new frame after closures: approximately 525ms and 3061ms respectively.
  New socket to first frame was only 173ms and 188ms; most of the latter gap
  preceded attachment. Consistent with existing passive retry/metadata cadence.
- Concurrent agent/terminal ERR_NETWORK_CHANGED still occurs and recovers, but
  does not explain these explicitly authority-revoked media closures.
- The bud_offline 503s in the console belong to a different thread
  (028bbcfe-6470-44f6-9694-9bec8dccbda9), not this browser test.

Next useful click investigation: identify the intercepting element using bounded
structural diagnostics/controlled reproduction, without logging page/input text
or bypassing actionability. Separately consider media attachment continuity for
agent-to-agent epoch changes; preserve all private-control revocation fences.

## Phase 3j implementation validation

Implemented default passive continuity across agent epochs, with independent
in-memory daemon revocation memory for privacy transitions. Service groups retain
current carrier/owner/session/generation binding; web preserves agent canvas identity.
No Reddit click, network-change, polling cadence or private lease change.

Passed: service TypeScript and web TypeScript builds; 21 focused service tests
(control, transport, relay and idle), 6 mounted viewer tests, 4 daemon authority
tests, and a real Chrome operation-driven media fixture. The Chrome fixture keeps
one socket through an agent epoch advance, receives refreshed pixels, rejects an
old-epoch command, idles without captures, and closes on disconnect. Relay tests cover continuity and delayed authorization after a control fence.
The user clarified the browser feature is not live: Phase 3j compatibility flags
and fallback paths were removed. There are no new wire or metadata fields.

Manual acceptance remains: rebuild/restart the user's daemon, reload the web app,
then send follow-up browser tasks in one thread and compare browser-media connection
IDs. They should remain stable across agent-only turns, and change on takeover/return.
Do not interpret unrelated network disconnects as continuity failures. No second
user-identity daemon was started; the live test owns an isolated local Chrome fixture.
