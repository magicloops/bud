# Debug: mobile streaming swipe pauses private control

## Environment and reproduction

2026-09-28: integrated experimental web scrolling and typing work. The user opens
the mobile hosted viewer, takes control and swipes. No visible scroll occurs;
control pauses with `Browser input was not confirmed`. Network path and matching
daemon/service error have been requested, not yet supplied.

## Observations

Mobile pointer gestures map to bounded HTTP scroll input through the same serial
queue as desktop wheels. This message is only emitted after dispatch begins and
fetch/response processing fails, or one of four canonical uncertain/control errors
arrives. It does not identify which error occurred. Service input dispatch has a
five-second deadline; an unknown result becomes `browser_input_uncertain` and
fences the controller. Merely overflowing the gesture queue does not produce
this message. Stale frame/focus rejections use a different recoverable message.

The available checked-in scroll logs are from September 15, so cannot diagnose
this experiment. Existing ngrok connection records do not identify the failed
input outcome. No root cause has been established.

## Hypotheses

- Command CDP stalls (including the previously observed hidden wheel failure),
  causing service timeout and unknown execution.
- Mobile reaches a service without the experiment flag and is still exercising
  screenshot capture/input contention.
- WK/network response fails, or controller authority is lost during dispatch.

## Next evidence and diagnostic change

Keep scrolling physics, timeouts, input serialization and no-replay unchanged.
Display only fixed uncertain-error categories, input kind, media mode and elapsed
request milliseconds in the existing error. Do not expose input, coordinates,
URLs, tokens, raw error bodies or exception messages. The phone can then report
whether this was streaming or screenshots, timeout-like timing, and the canonical
code without needing Web Inspector. Correlate daemon human_input/CDP and stream
termination logs before changing execution behavior.

Relevant spec: web/src/features/browser/browser.spec.md. Ownership remains the
existing authenticated session/controller; no route, authority or protocol change.

## Confirmed failed path

User logs at 18:41:26, 18:41:40 and 18:43:07 UTC show
`Input.dispatchMouseEvent` cancelled while awaiting acknowledgement after
4842–5000 ms. Screenshot `media_lock_wait` repeats while that input holds the
page lock; the media task subsequently ends at `phase=list_targets` with
`browser_channel_interrupted`. This is the screenshot path, not `private_stream`.
The earlier transport/send error prompted channel recovery, but the new wheel
then independently stalled waiting for Chrome's acknowledgement. The cancellation
explains the uncertain-input pause; it does not establish why Chrome stalled.

Read-only inspection found the local service listening on port 3000 (PID 48145)
was launched without `BUD_BROWSER_STREAMING_EXPERIMENT`, and service/.env has no
setting for it. The launcher preserves inherited environment. Experimental
private mode is selected server-side, equally for web and mobile; it is not
activated by updating the mobile app. The next step is to restart the user's dev
launcher with `BUD_BROWSER_STREAMING_EXPERIMENT=1 pnpm dev:ngrok` (or the HTTPS
profile if that is the intended setup), then reopen the visit and take control.
No processes or environment files were changed automatically.

## Validation

28 gesture and mounted desktop/mobile viewer tests pass, including streamed
wheel uncertainty cancelling momentum with no replay and the media-mode diagnostic.
Web `pnpm exec tsc -b` and `git diff --check` pass. No scrolling, daemon timeout,
media admission or private-control semantics were changed. The device experiment
must be repeated with streaming actually enabled; its result is still pending.
