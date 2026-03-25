# Validation Checklist: False Bud-Offline / Terminal `503` Stabilization

## Backend Ownership

- [ ] Reconnect a Bud daemon and confirm the newer socket remains authoritative for the same `budId`
- [ ] Confirm stale socket timeout/close paths no longer evict the live Bud session from the routing map
- [ ] Confirm true daemon shutdown still marks the Bud offline and suspends active terminal sessions

## Browser / Terminal

- [ ] Open a thread and keep the terminal active for several minutes without `terminal/ensure` `503` loops
- [ ] Refresh the page during active terminal use and confirm the terminal recovers without a false `Bud offline` state
- [ ] Keep two tabs open on the same thread and confirm both remain stable
- [ ] Keep a claim-flow tab open alongside an active thread and confirm it does not destabilize the Bud connection
- [ ] Confirm a normal quiet period does not trigger `service_restart_detected` churn

## Streaming / Reconnect

- [ ] Confirm `/api/threads/:thread_id/terminal/stream` stays live during ordinary terminal use
- [ ] Confirm `wss://staging.bud.dev/ws` reconnects cleanly after a daemon reconnect
- [ ] Confirm a real daemon disconnect still surfaces as an offline transition and recovers after restart

## Observability

- [ ] Service logs clearly distinguish stale cleanup from active cleanup
- [ ] Frontend network logs no longer show sustained `POST /api/threads/:thread_id/terminal/ensure` `503` retries during healthy operation
- [ ] Cloudflare Worker metrics are reviewed after the fix and any remaining disconnect counts are explainable

## Documentation

- [ ] The debug note is updated with post-fix validation results if behavior changed materially
- [ ] Relevant specs are updated for any changed service/web behavior
- [ ] The stabilization outcome is linked from the root documentation catalog
