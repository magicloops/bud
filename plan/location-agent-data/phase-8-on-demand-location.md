# Phase 8: On-demand location for agents

Part of [location for agents, automations and apps](README.md). Requires 6.5
(fixes). It ships in two steps:
- **8.1 (silent push):** needs no new permission from Apple. The user can stop
  it by force-quitting Bud.
- **8.2 (location push extension):** Apple's intended mechanism, which needs an
  entitlement Apple must approve.

The agent tool and the service contract are the same for both.

## Problem

Agents only see stored location. Asking "where am I?" while Bud is in the
background returns the last visit or point, which can be minutes or hours old.
Agents should be able to ask the phone for its current position, with the
user's permission and visible limits.

## Design

### Permission and limits

- **No separate opt-in.** Current-location reads are covered by the existing
  `location.read` agent grant (decided October 19, 2026). The grant's
  description on web and iOS says that agents may ask the phone for its current
  location.
  - Automations with `location.read` in `data_access` can call the tool too.
  - Withdrawing `location.read`, or the iOS location permission, stops it.
- **Rate limits:** at most 1 request a minute and 30 a day per owner. Requests
  over the limit get the stored location, with the reason.
- **Log:** the Location screens list recent requests (time, the agent's
  conversation or automation, and outcome).
- **iOS indicators:** iOS shows its location indicator when the phone takes a
  fix. Bud adds nothing else to the phone.

### Request flow (shared by 8.1 and 8.2)

- **The tool:** `location_current` (agent tool) creates a `location_request`
  row with owner, requester, `status`, `expires_at` (now + 20 seconds) and
  `delivered_via`, and sends a push to the owner's devices.
- **The phone:** it takes a 6.5 fix with `reason: request` and the
  `request_id`, and uploads it immediately.
- **Fulfilment:** the processor marks the request fulfilled when the fix
  arrives.
- **Waiting:** the tool waits for the fix, using a notification on the request
  row and polling as a fallback.
  - On fulfilment, it returns the fix with its age and address.
  - On expiry, it returns `location_recent`'s answer plus
    `fresh: false` and a reason:
    - `no_device`;
    - `push_failed`;
    - `no_response` (the phone may be force-quit, in Low Power Mode, or
      throttled by iOS).
- **Device choice:** devices with a current installation whose last upload
  reported Always permission. With When In Use only, the tool returns stored
  location and says why.

### 8.1: Silent push wakes the app

- **Push:** APNs `apns-push-type: background`, priority 5, `content-available: 1`,
  with payload `{ type: "location_request", request_id }`. It's sent through
  the existing sender in `service/src/notifications/apns.ts`.
- **iOS:**
  - adds the `remote-notification` background mode;
  - in `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`:
    1. check the owner;
    2. take one fix (up to 10 seconds);
    3. commit it;
    4. flush the upload;
    5. call the completion handler within about 25 seconds.
- **Limits:**
  - iOS treats background pushes as best effort and throttles them, so a few
    an hour usually get through;
  - they aren't delivered while the app is force-quit, which is also how the
    user stops them;
  - Low Power Mode may delay them.
- **First step (device spike):** confirm that a push-woken app with Always can
  get a fix with `requestLocation()` (or `CLBackgroundActivitySession`), and
  measure push-to-fix time. If it can't, skip to 8.2.

### 8.2: Location push service extension

- **Entitlement:** request `com.apple.developer.location.push` from Apple. Do
  this early; the request explains that agents read location on request, under
  the user's location permission for agents, with rate limits and a visible
  log.
- **Extension:**
  - a `CLLocationPushServiceExtension` target;
  - the app registers with `startMonitoringLocationPushes`, and the service
    stores the location push token per installation;
  - pushes use `apns-push-type: location` and the topic
    `<bundle id>.location-query`.
- **Upload from the extension:** the extension runs without the app.
  - It gets a fix and posts it straight to a small authenticated endpoint
    (`POST /v1/location/fixes`).
  - It authenticates with a credential shared through an app group and the
    keychain.
  - It writes nothing to the app's SQLite store. The fix is stored as a
    `location.fix.v1` raw event server-side.
- **Behaviour:**
  - works even when the app isn't running;
  - withdrawing `location.read` (or the iOS location permission) is how the
    user stops it.
  - The service prefers 8.2 when a location push token exists, and falls back
    to 8.1.

## Out of scope

- Continuous tracking or live sharing sessions.
- Requests from private apps (`/api/app-data`). Revisit after agents.

## Tests

- **Service (PostgreSQL):**
  - request lifecycle (fulfilled, expired, rate-limited);
  - device choice;
  - the `location.read` check and the automation ceiling;
  - fix matching by `request_id`;
  - log listing.
- **iOS:**
  - push handling with a fake fixer (owner mismatch, timeout, completion
    handler always called);
  - 8.2 extension upload with a fake session.
- **Device:**
  - background, locked, Low Power Mode, force-quit (8.1 fails cleanly; 8.2
    works);
  - repeated requests against the rate limit;
  - time from asking to answer.

## Rollout

1. 8.1:
   - service: requests, tool, push and the updated grant wording;
   - then iOS: background mode and handler.

   Older iOS builds never answer, so the tool reports `no_response` with
   stored data.
2. 8.2 after the entitlement is approved:
   - a new extension target, App ID capability and provisioning profile
     update;
   - then the service endpoint and push type.
