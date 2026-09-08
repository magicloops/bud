# Debug: stopped queue callback lifetime

## Observed

On account switch, TimelineCoreManager clears its SyncEngine reference after
scheduling stop. BackgroundUploader holds the result handler weakly, so cancellation
or already-completed upload callbacks can lose their queue handler before SQLite
release/ACK processing. Background event routing also only considers the active
partition.

## Fix

Retain retired upload/engine pairs until both URLSessions invalidate and all
result-handling tasks drain. Route background event completions by exact session
base to the active or retired pair. Cold-process signed-out restoration remains
a separate follow-up; this fixes the in-process lifetime boundary first.
