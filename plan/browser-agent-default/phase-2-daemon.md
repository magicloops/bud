# Phase 2: Daemon override lifetime

Status: implemented locally; automated checks passed; remaining acceptance below. Requires Phase 1 contract.

## Objective

Human authority always expires locally, without a working viewer or service.
Returning to agent never overlaps a still-running human side effect.

## Work

- [x] Replace `Authority::expire/pause` sticky-private behavior with retirement of
  the override and agent-default authority. Remove paused-controller recovery and
  checkpoint restoration of a human hold across daemon restart.
- [x] Keep takeover admission/drain and monotonic epochs. Only explicit acquisition
  grants human input. Renewal cannot create an override or revive one after expiry.
- [x] Enforce lease deadlines independently of the page mutex, screenshot capture,
  media ACKs and pending input. A slow operation cannot extend the lease.
- [x] End/expiry fences input and private media immediately, cancels unsent work,
  stops screencast and removes scoped focus emulation. Hide any native window
  revealed for human takeover before agent execution resumes; failed cleanup is
  an execution/recovery error, never a permanent request for user Return.
- [x] Drain bounded in-flight input and transition to executable agent state. A
  timed-out dispatch is unknown, not proof it stopped: fence/replace the affected
  command channel and verify readiness before admitting another mutating operation.
  Do not replay human input. If readiness cannot be established, report unavailable
  and automatically reconcile on recovery without restoring human authority.
- [x] Provide authoritative state/receipt on automatic expiry and reconnect, using
  existing control transport. Lost events are repaired by status reconciliation.
- [x] Preserve workspace target isolation, stale frame/focus rejection, media fences
  and at-most-once page dispatch across a rapid end/new-takeover sequence.
- [x] Audit shutdown, browser process replacement, idle expiry, native windows and
  service-carrier replacement for paths that restore `private_content` or pause.

## Validation

- [ ] Fake-clock tests: renew-before-deadline, renew-at/after-deadline, delayed or
  reordered renewal/end, old carrier, new takeover, no timers blocked by page work.
- [ ] Disposable Chrome: expiry during typing/wheel/navigation/capture, no duplicate
  input, no human action after agent work begins, focus/window cleanup and reuse.
- [ ] Drop service link while human controls: local expiry still occurs; reconnect
  reports agent authority and readiness, never grants the former viewer input.
- [ ] Both screenshot and experimental WSS media paths obey the same authority.
- [ ] Rust build, focused tests, rustfmt/clippy appropriate to changed modules.

Update browser spec and wire/protobuf codecs/fixtures if message shapes change.
Old daemon/service pairings must fail clearly under the coordinated new contract;
do not silently fall back to the old sticky-pause behavior.

## Recorded evidence

See [Phase 5 implementation record](phase-5-validation-and-cutover.md#implementation-record) for commands/results and outstanding physical checks. Broader acceptance boxes above remain open where the full scenario has not been run.
