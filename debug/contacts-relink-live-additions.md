# Debug: Contacts relink could emit historical additions

## Observed

Disabling collection preserves its committed Contacts snapshot. Re-enabling
previously started an ordinary incremental scan, so identifiers accumulated while
disabled could be emitted as live newly-observed contacts.

## Fix

Before persisting a new collection opt-in, stop the old producer and durably request
reconciliation. Only then enable/start it, checking the same collection partition
after each await. First imports remain baseline; reimports use resync and suppress
live additions. Failure to persist reconciliation leaves collection disabled.
