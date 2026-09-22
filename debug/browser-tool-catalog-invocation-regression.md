# Debug: Browser tools omitted after context-accounting refactor

## Environment and reproduction
Local HTTPS service, thread `32ae526b-b0bc-4480-a953-590a624a4055`.
User explicitly requested Hacker News in the browser; the assistant reported browser
control unavailable and used web_search/web_read without a browser attempt.

## Cause
`AgentService.getContextTools` constructed a context without `invocation`.
`BrowserBroker.available` required it, so the new shared catalog hid browser tools.
The same check also hid them from idle context accounting, where no invocation exists.

## Fix
Keep runtime capability discovery read-only and separate from execution eligibility.
The shared catalog checks actual invocation eligibility for live calls and durable
service configuration for idle previews, forwarding real invocation context when
present. Broker availability checks carrier capabilities; repository dispatch still
requires the real owner/thread/invocation lease and fence. No fake invocation, new
permission, daemon change or browser action is introduced by a meter read.

## Validation
Regression coverage uses the real broker and a capable carrier for live, idle,
legacy, offline and unavailable cases. No prompt changes.

Service build and both focused catalog/broker tests pass. The watched local service
reloaded and is listening on port 3000. Live agent re-test remains.
