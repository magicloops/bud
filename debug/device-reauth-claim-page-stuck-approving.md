# Debug: Device reauth claim page stuck on "Approving device..."

## Environment

- Repo: `/Users/adam/code/bud`
- Flow under test: Bud device reauthentication after removing the stored device secret
- Browser auth: existing signed-in session
- Service/device-auth path:
  - `POST /api/device-auth/start`
  - `POST /api/device-auth/poll`
  - `GET /api/device-auth/flows/:flowId`
  - `POST /api/device-auth/flows/:flowId/approve`
  - `/ws` challenge-response reconnect

## Repro Steps

1. Start from an already claimed Bud install with a persisted `installation_id`.
2. Remove or invalidate the local Bud device secret.
3. Start the daemon so it falls back into the device-auth bootstrap flow.
4. Open the printed claim link in a browser with an active session.
5. Observe the claim page and Bud logs while the daemon polls and reconnects.

## Observed

- Bud only entered the reauth path if the stored `device_secret` was set to an empty string.
- Removing the field entirely, or setting it to `null`, caused Bud to crash instead of treating the local identity as invalid and reauthing.
- After opening the claim link, the browser showed the `Approve this Bud device` screen and the status text remained `Approving device...`.
- Bud nevertheless appeared to reconnect successfully according to logs.

## Expected

- Bud should treat a missing or malformed local device secret as a recoverable condition and fall back into the claim flow without crashing.
- Once the claim is approved and the daemon reconnects, the browser claim page should move out of its in-progress state and show either:
  - `Device approved. Bud can reconnect now.`, or
  - `Device is already connected.`

## Relevant Files Reviewed

- `bud/src/main.rs`
- `service/src/routes/device-auth.ts`
- `service/src/ws/gateway.ts`
- `web/src/routes/devices.claim.$flowId.tsx`
- `web/src/lib/api.ts`
- `web/src/contexts/auth-session-context.tsx`

## Findings

### 1. Bud identity loading is strict enough to make secret deletion crashy

In `bud/src/main.rs`, `DeviceIdentity` requires:

```rust
struct DeviceIdentity {
    bud_id: String,
    device_secret: String,
    server_url: String,
    name: String,
    default_cwd: String,
}
```

`load_identity()` deserializes that file directly. If `device_secret` is missing or `null`, deserialization fails and the daemon returns an error instead of downgrading to "identity missing/invalid, start claim flow". An empty string still deserializes, which is why it reaches the normal `AUTH_FAILED -> clear_identity() -> bootstrap_device_auth()` path.

### 2. The web claim page is not designed to observe the server's post-approval state transitions

In `web/src/routes/devices.claim.$flowId.tsx`:

- the flow is fetched once on mount
- the page auto-posts `/approve` when `flow.status === 'pending'` and `currentUser` exists
- there is no follow-up polling or refetch after approval starts
- there is no subscription to the service-side `approved -> completed` transition

So the page has only local optimistic state, not authoritative server state.

### 3. The service does have a second transition after approval

In `service/src/routes/device-auth.ts`:

- `/approve` sets the flow to `approved`
- it stores `issuedDeviceSecret`
- it returns immediately with `{ status: "approved", bud_id }`

In `service/src/ws/gateway.ts`:

- after a successful challenge reconnect, matching `device_auth_flow` rows are updated to:
  - `status = "completed"`
  - `completedAt = now`
  - `issuedDeviceSecret = null`

So there is a real service-side lifecycle:

```text
pending -> approved -> completed
```

but the browser page does not currently track it after the initial `approve` request.

## Hypotheses

### Hypothesis 1: the claim page is stale because it never revalidates after approval

This is the most likely product-level issue.

If `/approve` succeeds and Bud reconnects quickly, the canonical flow state moves to `completed` in the database, but the page never refetches `GET /api/device-auth/flows/:flowId`. That leaves the browser dependent on its one local state update rather than the actual flow row.

This cleanly explains a class of "browser and daemon disagree" symptoms, even if it does not fully explain why the visible text remained specifically `Approving device...` instead of `Device approved...`.

### Hypothesis 2: the `/approve` request reached the server but did not settle cleanly in the browser

The exact `Approving device...` text only renders while:

- `flow.status === "pending"`
- `currentUser` is present
- `approving === true`

That means the component still believed the approval request was in flight. If the request mutated server state but never completed from the browser's perspective, the daemon could still reconnect while the page remained stuck in its optimistic in-flight state.

The current UI gives us no instrumentation to distinguish:

- request still pending
- request succeeded but local state never updated
- request failed after server-side mutation

### Hypothesis 3: Bud reauth currently depends on an invalid-but-deserializable identity shape

The need to set `device_secret` to `""` strongly suggests the daemon's fallback behavior only works once the file remains structurally valid JSON for `DeviceIdentity`. This is a separate bug from the stuck web status, but it affects the same manual test path and is worth fixing before more reauth validation.

## Proposed Fix

Minimal patch outline, pending confirmation from runtime logs/network traces:

1. Make Bud treat malformed/missing `device_secret` as "identity unavailable" rather than a fatal startup error.
2. Make the device-claim page revalidate flow state after approval starts.
3. Continue revalidating until the flow reaches a terminal browser-visible state:
   - `approved`
   - `completed`
   - `rejected`
   - `expired`
4. If the `/approve` request is intentionally optimistic, still poll `GET /api/device-auth/flows/:flowId` so the browser reconciles against the service's source of truth.

## Spec Files Affected If We Fix This

- `bud/src/src.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/routes/routes.spec.md`

