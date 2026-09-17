# Browser lifecycle simplification

## Objective
A page-operation failure must not masquerade as a renewal failure. Preserve the
existing private-content fence and explicit return; avoid a new scheduler.

## Contract
- The daemon renews an existing controller using only its authority mutex, without
  waiting for CDP, mutating page state or consuming page-operation sequence.
- The service sends that renewal independently of input/resize when the daemon
  advertises `independent_renewal`. Older daemons retain the existing serialized
  renewal path. Old services can renew new daemons using the existing command.
- Unknown input/resize outcomes revoke the service controller and fence media
  immediately. Do not replay gestures. Recoverable stale-frame/input rejections
  remain local to that gesture.
- The viewer stops renewing when private media is lost, preserving an input or
  resize error over a secondary media/renewal error. Late renewal replies cannot
  clear a failure or restore ownership. Only explicit user recovery resets it.
- Renewal remains 5 seconds; lease remains 15 seconds. No generic retry loop,
  automatic reacquisition, independent CDP connection, new DB state, or scheduler.

## Ownership and rollout
Session metadata, controller lookup and media remain owner/Bud/thread scoped.
The authenticated viewer plus auth-session-bound viewer ID identifies control.
No new rows. Capability addition is optional and additive; new service/old daemon
keeps serialized renewal, old service/new daemon still uses the same renew command.
Restart Bud and reload web after deployment for full effect.

## Validation
- Renew while the daemon page lock is held; stale controller and revoked epochs reject.
- Service renewal completes while input dispatch is pending; unknown input fences.
- Viewer preserves the input failure against late renewal and stops its heartbeat.
- Existing private capture, input, return and passive handoff tests still pass.

Specs: daemon browser, service browser, web browser; protocol capability docs.

## Implementation status
Implemented across daemon, service and web. Live Chrome browser tests pass (10),
as do focused service and mounted viewer tests; service/web builds pass.
The daemon executable is rebuilt. Restart the existing Bud (do not launch a second
copy), reload web and retest fitting plus private input. Automated coverage does
not establish signed-in end-to-end acceptance.
