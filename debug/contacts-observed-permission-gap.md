# Debug: Observed Contacts denial lost before regrant

## Environment and reproduction

Mobile Contacts producer with a committed authorized snapshot. Revoke OS access,
foreground the app, then grant the same authorization level after adding contacts.

## Observed

The denied scan returned before persisting any checkpoint or reconciliation
marker. The next authorized scan could compare two identical authorization values
and classify contacts observed across the permission gap as live additions.

## Expected and proposed fix

Persist an outstanding reconciliation marker when denial is observed after a
committed snapshot. Preserve the prior snapshot and queue; do not enumerate while
denied. Regrant consumes the existing durable resync path, suppressing live actions.
Repeated denied scans reuse the outstanding marker. Completely unobserved OS
permission changes and limited-access membership ambiguity remain device work.

Update the mobile ingestion design and remaining-work audit. Validate with the
existing snapshot/resync package tests and a full simulator build.
