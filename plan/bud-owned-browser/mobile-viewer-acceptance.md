# iOS browser handoff: acceptance and delivery checklist

Status: **Full matching-stack matrix pending.** Updated 2026-09-25. High-level
phone/ngrok testing occurred; desktop/agent scrolling was accepted. Mobile
scrolling and the device/privacy matrix below are not signed off. Use with the
[implementation plan](phase-3b-ios-browser-viewer.md) and
[contract reference](mobile-viewer-contract.md).
The [mobile follow-through plan](../../../bud-mobile/plan/browser-sessions-current-scope.md)
tracks implementation prerequisites M1–M2 and physical acceptance M3.

## Environment and evidence

Record for every acceptance run: service/shared-viewer SHA, daemon version/SHA,
Chrome version, mobile build/SHA, physical device/iOS version, host OS, transport,
network RTT/bandwidth and whether the test used development or release builds.
Use an owner account plus a distinct test user and two threads on the same Bud.
Run the daemon only once for its identity. Keep the user's normal Chrome profile
separate from the persistent Bud profile.

Start with a validated macOS daemon and a trusted HTTPS service reachable from
the phone. Phone `localhost` is not the developer's Mac. Use the project's
configured development tunnel/LAN setup or hosted service with valid TLS; do not
disable TLS/Origin validation to make WKWebView work. Test the actual deployed
edge's viewer route, bootstrap POST, cookie forwarding and WebSocket upgrade.

Use deterministic test pages for focus, scrolling, form input, popups, navigation
and delayed responses, followed by an actual-agent public-site/private-login run.
A third-party CAPTCHA outcome is not a reliable transport acceptance test.
Use disposable test credentials and keep private payloads out of traces.

## Gate 1 — authentication and read-only viewing

- [ ] Native bearer inventory returns only the current owner's thread sessions.
- [ ] Foreign Bud/thread/session IDs return 404 before allocation/read/stream;
      missing/expired authentication returns 401.
- [ ] Grant redemption is one-use, bounded, owner/workspace/viewer-scoped; expired,
      replayed, wrong-viewer and wrong-resource grants fail.
- [ ] Scoped cookie cannot authorize generic account/chat APIs or another session;
      REST and WS resolve the same principal and revocation.
- [ ] Unauthorized Origin, forged bridge origin, subframe messages and stale visit
      nonces fail. No native access token reaches web JavaScript or URLs.
- [ ] Sign-out/account switch clears the view/cookie store and revokes access;
      late responses from the previous account cannot update UI.
- [ ] Passive first frame works through hosted HTTPS/WSS on an actual iPhone.
- [ ] Agent idle for several minutes leaves the last authorized frame visible;
      no screenshot polling or false disconnect based on frame age.
- [ ] Closing/reopening presentation preserves remote tabs and chat draft/scroll.
- [ ] Old history/repeated inventory does not repeatedly reopen a dismissed view.
- [ ] Empty inventory and unavailable browser add-on show useful UI without
      creating a new workspace as a polling side effect.

## Gate 2 — privacy, control and chat continuation

- [ ] An actual agent opens a login page and requests handoff; phone opens the
      same remote page, takes private control and can enter test credentials.
- [ ] During private control, agent DOM/screenshot/action requests across both
      threads park or reject appropriately; passive web/iPad views receive no
      private images. Delayed pre-takeover frames cannot appear afterward.
- [ ] User can keep chatting during browser waits. Inline prompt stays visible
      when agent runtime is inactive but invocation is waiting_for_user.
- [ ] Inline Return uses the same mounted viewer identity. No duplicate acquire
      loop or second native controller; double taps produce one effective return.
- [ ] Live private workspace without this visit's lease offers explicit Take
      control, then Return after acknowledged ownership. Confirmed runtime
      replacement clears extinct authority without requiring Return as repair.
- [ ] Another live web/mobile controller cannot be stolen implicitly. Test same
      workspace and different thread on the same shared browser.
- [ ] Confirmed Return resumes eligible browser waits; agent observes current
      state before reconsidering deferred action. No stale click replay.
- [ ] Cancel affects the selected waiting invocation; it neither resumes private
      browsing nor cancels unrelated newer chat work.
- [ ] Canonical completion/cancellation wins over delayed pending history/state.
- [ ] Passwords, OTPs, frame bytes, focus/recovery tokens and grants are absent
      from transcript, provider context, logs, analytics and crash breadcrumbs.

## Gate 3 — device input, geometry and lifecycle

- [ ] Tap coordinates work at letterboxed sizes, 1x/2x image density, portrait,
      landscape, local zoom and iPad split view. Taps outside the image do nothing.
- [ ] Swipe scroll is responsive, directionally correct and bounded; no click at
      swipe end, duplicate native scroll or growing queue after input stops.
- [ ] Keyboard opens from an explicit tap; type before/after focus ACK, edit an
      email field, delete, Enter/Tab, paste, emoji, CJK composition and multiline.
- [ ] Composition commits once. Slow ACKs and queue pressure do not duplicate
      text. Stale focus asks for reselection rather than typing into another field.
- [ ] OTP workflow backgrounds to another app and returns. Private pixels are
      covered in the app switcher; input/renewal stop; resumed app refreshes status
      and requires takeover after release/expiry. No automatic Return.
- [ ] Device lock, interruption and WKWebView content-process termination produce
      the same safe paused behavior; release need not reach the server to be safe.
- [ ] Keyboard/menu/handoff text appearing does not resize the remote page.
      Explicit Fit waits for matching viewport pixels before private input.
- [ ] Passive phone fitting does not fight a desktop sizing viewer.
- [ ] Remote Back changes the remote tab; local dismiss returns to chat instead.
- [ ] Remote OAuth popup targets stay remote and selectable; local WebKit popup
      handling does not replace the hosted viewer with website HTML.
- [ ] Last remote tab closed: empty state keeps Return usable and later explicit
      agent open creates a page without requiring saved-page recovery.
- [ ] Controls support VoiceOver labels/focus, Dynamic Type, reduced motion,
      reachable keyboard-open actions and 44-point targets. Document the separate
      limitation that remote canvas content has no native accessibility tree.

## Gate 4 — interruption and recovery matrix

| Test | Expected evidence |
| --- | --- |
| Wi-Fi → cellular / temporary network loss | Reconnect with refreshed authority; no old input replay or permanent renewal-error loop |
| Response lost after click/text/Return dispatch | Unknown outcome is visible; no automatic resend; fresh metadata/observation drives next choice |
| Service restart, passive viewer | Reattach when available without asking user to take private control unnecessarily |
| Service restart, private viewer | Private intent remains; same authorized mounted viewer can use valid proof, otherwise explicit takeover |
| Daemon restart | Visible ensure reconciles runtime; confirmed replacement discards old evidence and restores eligible full public URLs; surviving private runtime stays protected |
| Zero eligible saved URLs | Usable empty workspace; agent opens an explicit URL without saved-page or takeover/Return repair |
| Recovery request uncertain | Reconcile through shared ensure; never replay uncertain cell or page mutations |
| Expired native visit / WK process killed | Fresh owner-checked bootstrap with bounded recovery; no inherited private proof or automatic takeover/Return (M2) |
| 24-hour idle workspace expiry | Public checkpoints/profile persist; next use restores pages and fresh REPL state; private expiry never returns automatically |
| Session close/thread deletion/unclaim | Frame/authority cleared; unavailable terminal state, no endless retry |
| Resize or acquire completes after dismiss | Late result cannot resurrect input/UI; best-effort release and lease fallback |
| Web control while mobile suspended | No silent mobile reacquire on foreground; report competing controller |
| Two threads share sign-in | Account available on second thread while tab selection remains workspace-scoped |

Run these with active chat/terminal streaming as well as browser-only. Keep
transport failures, media failures, private lease failures and browser process
loss distinguishable in diagnostics. An open Chrome window alone is not proof
that viewer authority or capture is healthy.

## Performance and resource acceptance

These are provisional targets, not established mobile measurements:

- Measure tap/scroll/text to visible remote result; target p95 below 500 ms on a
  documented representative network. Report sample count and capture mode.
- Record attachment-to-first-frame, decode/draw time, image bytes/sec, dropped
  frames, input ACK latency, device memory and host capture CPU.
- Run a 30-minute private session and repeated open/close/thread switches. Memory
  must remain bounded; one mounted viewer/socket/renewal loop, no accumulating
  decoded images, timers, script handlers or pending requests.
- Verify no capture with no eligible viewers, no ongoing phone decode/polling in
  background, and operation-driven passive viewing with no idle screenshot loop.
- Measure 60 seconds after healthy settlement: zero periodic native inventory or
  hosted metadata/resource GETs. Count state heartbeats, five-second private lease
  renewals and five-minute native visit renewal separately; none imply new pixels.
  Native zero-poll acceptance depends on Phase M1, not just hosted Phase 7f.
- Slow network must not play an old-frame backlog after reconnect. Keep frame
  credit bounded and never move frames through chat state or the native bridge.
- Compare chat scroll and terminal responsiveness with/without browser viewing;
  target added control/terminal p95 latency below 50 ms for the same workload.
- Profile release/device builds for acceptance; do not attribute debugger-only
  latency to production behavior. Reduce density/cadence before enlarging queues.

If targets fail, record measurements and the smallest mitigation. Do not expand
this phase into WebRTC or a native rendering engine without a separate decision.

## Automated coverage and final handoff

Service: grant scope/replay/expiry/revocation, auth-before-upgrade, foreign-owner
reads/writes, idle media revocation and recovery principal binding. Shared web:
bridge validation, suspend/late callbacks, existing control/input/fit races, touch
gesture classification and composition. Mobile: DTOs, discovery deduplication,
visit/account fences, navigation policy, handoff mapping and lifecycle events.
Keep real-device testing for WebKit keyboard, cookie/WS, app snapshots and gestures;
unit mocks cannot certify them.

Before enabling mobile browser viewing:

- [ ] All required gates passed or explicitly documented as product limitations.
- [ ] Owner/auth checklist, service/web/mobile specs and protocol docs updated.
- [ ] Any auth storage migration checked in and tested through deployment migrate.
- [ ] Service/shared viewer deployed before mobile; supported daemon identified.
- [ ] No credential/page payload logging; remove temporary per-event diagnostics.
- [ ] Existing proxy viewer, chat input/scroll, terminal and file views regressions
      pass; Browser and Web view remain distinct entry points.
- [ ] Record known issues with reproduction and follow-up owner, not “works on
      simulator.” Ubuntu and packaged-runtime acceptance remain separate tracks.

Delivery record template:

```text
Service/shared viewer SHA:
Daemon version/SHA + Chrome version + host OS:
Mobile build/SHA + device/iOS:
Deployment origin / transport / network:
Gates passed and evidence links:
Performance samples and p50/p95:
Known limitations and follow-ups:
Required migration / coordinated upgrade steps:
```
