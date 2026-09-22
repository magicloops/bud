# Debug: browser pane after daemon restart

## Reproduction
Open the web browser pane, restart its Bud, and reopen the pane. It shows
“paused or unavailable”, an empty page selector, and an ineffective reconnect.

## Cause
Chrome and its temporary profile belong to the daemon process. Viewer metadata
currently reflects only the durable session row, not the current daemon boot.
A disconnected transport alone does not prove restart; a different advertised
boot does. A removed/closed row can also return 404 after reconciliation.

## Fix
Add an owner-authorized runtime status projection to existing metadata/list/control
responses, comparing the stored boot with the current capable carrier. No new
rows, wire changes or daemon release. Clear stale media/private UI on confirmed
restart and show an ended-session message; retain temporary disconnect recovery.
Hide page/fit/reconnect controls for ended sessions. Keep explicit close labeled
with its existing stop-run semantics; do not recreate a browser or resume private
work automatically. Handle missing-session responses without retaining stale UI.

## Validation
Service status projection: same boot, no connection, changed boot, interrupted.
Mounted viewer: restart clears private controls/media and hides reconnect/page
selector; 404 shows a generic ended/unavailable message without inferring restart.
Service/web builds and targeted tests. Manual acceptance remains pending.

## Results
Service control tests (11) and mounted viewer tests (3) pass; service/web builds
pass, with the existing web bundle-size warning. Targeted ESLint and diff checks
pass. Ended inventory also suppresses the misleading return-control chat notice.
No daemon change or restart is needed to load this service/web presentation fix.
