# Debug: Mobile WK bootstrap rejected by Origin gate

## Environment and observed evidence
2026-09-26, M1/M2 mobile and local service through ngrok. Web viewer works.
Sanitized ngrok inspection (no grants, cookies, bearer tokens or page contents):

- 01:36:45 -07:00: POST workspace viewer-grants → 200.
- 01:36:49 -07:00: POST viewer-bootstrap, Origin: null → 403 origin_denied.
- Visit revocation → 200 after native classified the bootstrap response as denied.

This is before media/control acquisition, not a competing-controller failure.
M2 assumed native WK POST omitted Origin; initial WebKit navigation has an opaque
origin and sends the literal null instead. Existing route tests deliberately
reject null and therefore did not reproduce native's actual outgoing request.

## Reproduction and fix
A standalone macOS WKWebView probe to a loopback HTTP listener verifies that
explicitly setting Origin on the native URLRequest preserves that header on the
wire. Set the configured service origin (scheme/host/port only, no trailing slash)
on bootstrap POST. Retain service rejection of null/foreign origins and one-use,
owner-bound grant validation. This changes neither cookie scope nor ownership.
Native bridge securityOrigin validation remains mandatory after navigation.

## Validation
Add a native outgoing-request regression for hosted and nondefault-port origins,
rerun native visit tests and service bootstrap rejection tests. The local real-WK
probe is macOS evidence; physical iPhone success must be rechecked after rebuild.
No daemon restart or service auth relaxation is needed.

Results: all 12 BrowserVisitTests passed in iOS Simulator (xcodebuild test, Bud
Debug, /tmp/bud-mobile-m2-build). Service mobile-routes.test.ts passed, including
null/foreign rejection and trusted/no-Origin success. The temporary loopback
probe server was stopped. Physical rebuild/retest remains pending.
