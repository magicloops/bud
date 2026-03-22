# Debug: Post-Claim Malformed Hello Frame

## Environment

- Repo: `/Users/adam/bud`
- Date: `2026-03-20`
- Local setup: `service` and `web` running; browser login and device claim working
- Bud reconnect target: `ws://localhost:3000/ws`
- Machine check: `tmux` is not installed on this machine (`which tmux` and `tmux -V` both failed)

## Repro Steps

1. Start the local service and web app.
2. Start Bud on a machine without an existing `~/.bud/identity.json`.
3. Approve the claim flow in the browser.
4. Observe Bud save the issued identity and reconnect to `/ws`.
5. Observe repeated handshake failures:

```text
Saved bud identity bud_id=... path=/Users/adam/.bud/identity.json
Device claim approved for Bud `...`. Connecting...
INFO Connecting to backend server=ws://localhost:3000/ws
WARN Session failed; retrying error=backend error during handshake (code=PROTO_VERSION_MISMATCH): Malformed hello frame
```

## Observed

- The browser-mediated claim flow succeeds and Bud persists `bud_id` plus `device_secret`.
- The failure happens on the first WebSocket reconnect after claim approval, before challenge-response can complete.
- The service returns `PROTO_VERSION_MISMATCH` with the generic message `Malformed hello frame`.
- `tmux` is missing on the machine that reproduced the issue.

## Expected

- Bud should be able to connect even when `tmux` is unavailable, advertising terminal capability as unavailable instead of failing the entire handshake.
- The device-claim bootstrap path and the steady-state `/ws` reconnect path should accept the same capability shape, or fail earlier with a field-specific error.

## Relevant Files Reviewed

- `bud/src/main.rs`
- `service/src/ws/gateway.ts`
- `service/src/routes/device-auth.ts`
- `bud/bud.spec.md`
- `service/src/ws/ws.spec.md`

## Findings

### 1. Bud serializes `tmux_version` as `null` when tmux is unavailable

In `bud/src/main.rs`:

- `probe_tmux()` returns `(false, None)` when `tmux -V` fails.
- `device_capabilities()` always includes `"tmux_version": self.terminal_manager.config.tmux_version`.
- In Rust `serde_json::json!`, `Option::None` serializes as JSON `null`, not omission.

That means a Bud running without `tmux` will currently emit a hello payload containing:

```json
{
  "capabilities": {
    "tmux_version": null
  }
}
```

alongside the other capability fields.

### 2. The service hello schema rejects `tmux_version: null`

In `service/src/ws/gateway.ts`:

- `handleHello()` validates the raw hello payload with `HelloSchema.safeParse(raw)`.
- `HelloSchema` includes `CapabilitiesSchema`.
- `CapabilitiesSchema` defines `tmux_version` as `z.string().optional()`.

`optional()` accepts omission, but it does not accept explicit `null`. If Bud sends `tmux_version: null`, `HelloSchema.safeParse(...)` fails and the gateway responds with:

```text
PROTO_VERSION_MISMATCH: Malformed hello frame
```

This matches the daemon log exactly.

### 3. The claim bootstrap path is looser than the `/ws` hello path

In `service/src/routes/device-auth.ts`:

- `POST /api/device-auth/start` accepts `capabilities` as `z.record(z.unknown()).default({})`.
- The claim flow stores requested capabilities without applying the stricter WebSocket hello schema.

So the current system allows this sequence:

1. Bud starts claim with capabilities containing `tmux_version: null`.
2. The browser approves the claim and the service issues `device_secret`.
3. Bud reconnects over `/ws` with the same capabilities shape.
4. The stricter `HelloSchema` rejects that reconnect as malformed.

That explains why claim approval succeeds while steady-state reconnect fails.

### 4. Missing `tmux` is the strongest current trigger

The local machine check showed `tmux` is absent. Given the code above, that directly produces `probe_tmux() -> (false, None)`, which in turn produces `tmux_version: null` in the hello payload.

This is the strongest explanation for the current repro. I did not find another field in the current hello frame that is as likely to become `null` on this machine.

## Hypotheses

### Hypothesis 1: `tmux_version: null` is the field failing hello validation

This is the primary hypothesis and is strongly supported by the current implementation:

- the machine is missing `tmux`
- Bud serializes `None` as `null`
- the service rejects `null` for `tmux_version`
- the error occurs at hello validation time

### Hypothesis 2: the protocol is brittle around optional capability fields

Even if `tmux_version` is the immediate trigger, the broader issue is that Bud and service currently disagree on whether "optional" fields may appear as explicit `null`.

If another optional hello capability is added later and serialized as `null`, the same class of failure will recur.

### Hypothesis 3: installing `tmux` is a likely workaround, not a full fix

If `tmux` were installed, `probe_tmux()` would likely return a real version string and Bud would stop sending `tmux_version: null`. That should make the current hello payload more likely to pass schema validation.

This is a plausible immediate workaround for this machine, but it does not fix the protocol mismatch.

## Proposed Fix

1. Preferred fix: update Bud to omit nullable capability fields from the hello payload instead of serializing them as `null`. `tmux_version` is the immediate case.
2. Compatibility hardening: update the service hello schema to tolerate `tmux_version: null` or normalize `null` to omission before validation.
3. Diagnostic improvement: when `HelloSchema.safeParse(...)` fails, log the actual Zod issues so `Malformed hello frame` points to the offending field.
4. Product behavior: missing `tmux` should degrade terminal support, not block Bud from connecting entirely.

## Proposed Next Check

- Capture or log the exact hello payload from Bud during reconnect, or log `HelloSchema` parse issues in the gateway, to turn the current code-based hypothesis into a directly observed field-level failure before patching.

## Spec Files Affected If We Fix This

- `bud/src/src.spec.md`
- `service/src/ws/ws.spec.md`
- `service/service.spec.md`
- `bud/bud.spec.md`
