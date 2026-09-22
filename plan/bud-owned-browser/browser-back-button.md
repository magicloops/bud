# Browser back control

Add a bottom-left hover/focus button (always discoverable on touch) to navigate
the selected remote page's history. Requires private control and a fresh frame;
never navigates the hosting web app. Use the existing owner/auth-session-scoped
input route and controller/epoch checks, with a typed `back` gesture gated by
`history_navigation` so old daemons never receive an unknown enum variant.

Daemon resolves the previous entry with Page.getNavigationHistory and requests
Page.navigateToHistoryEntry. Empty history is a recoverable no-op rejection. Clear
queued input/focus after navigation; do not replay on uncertain outcome. No new
rows, global keyboard interception or capture metadata. Button remains available
under private control; empty-history feedback explains why it did not navigate.

Validate live Chrome navigation, empty history, capability gating, mounted UI and
builds. Update daemon/service/web browser specs and docs/proto.md.
