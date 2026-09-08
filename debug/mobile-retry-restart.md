# Debug: mobile retry recovery

## Observed

`SyncEngine` keeps a reduced 413 batch limit only in memory. SQLite stores retry
deadlines, but the engine does not arrange a wake when an upload fails. Pending
work waits for an unrelated collection or foreground event.

## Fix

Persist the partition's reduced batch limit in SQLite. Read it before recovery
and persist reductions before releasing rejected batches. Expose the earliest
pending deadline, schedule a cancelable foreground retry and request the relevant
OS background task. OS scheduling remains best effort and is device-validated
separately; stored deadlines remain authoritative across restarts.
