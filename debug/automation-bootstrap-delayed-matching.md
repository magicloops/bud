# Debug: Bootstrap before delayed live matching

## Observation
A live contact event may be published but not matched when a human captures a
bootstrap snapshot. Excluding only existing deliveries would let the later matcher
schedule that same contact again for the same rule revision.

## Fix
Under the shared owner lock, the matcher checks frozen bootstrap membership and
its publication boundary before inserting a delivery. Captured contacts become
suppressed with bootstrap_snapshot_selected. Snapshot cancellation does not cause
that historical event to reappear as surprise live work.

## Validation
PostgreSQL fixture publishes an event, captures it, then matches it and verifies
one suppressed delivery. Snapshot retry membership/boundary stays unchanged.
