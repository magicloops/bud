# Debug: Orphaned mobile batch files

## Environment and reproduction

TimelineCore writes a UUID-named gzip file before SQLite markInFlight.
A crash between those operations leaves no membership identifying that file.
Likewise a crash after ACK deletion but before file cleanup leaves an unused file.

## Observed

SyncEngine startup only iterates SQLite in-flight IDs absent from OS tasks.
It never inventories unreferenced generated files. Such files can accumulate
personal-data copies and consume storage despite successful queue recovery.

## Proposed fix

At startup, after task/SQLite reconciliation, inspect only this partition's direct
batch files. Remove regular, non-symlink files with the exact generated UUID naming
format unless retained by either SQLite or OS upload tasks. Preserve unrelated
files/directories. Clean up a freshly built file when markInFlight throws, before
any enqueue. Test crash leftovers, retained files, unknown paths and event bytes.
No queued record or source checkpoint may be deleted by this cleanup.


## Validation correction

The first selected test build failed with:
```
QueueRecoveryTests.swift:152:69: error: value of type '[String]' has no member 'union'
```
Command: `xcodebuild test -scheme TimelineCore -destination
'platform=iOS Simulator,id=905B18E9-A744-40E2-B0C4-63B341E5D5BC'
-derivedDataPath /tmp/bud-v2-wire-tests
-only-testing:TimelineCoreTests/QueueRecoveryTests -parallel-testing-enabled NO`.
Log: `/tmp/bud-orphan-batch-tests.log`. Convert the fixture's SQLite ID array to
Set before combining references; production combines from the OS task Set.
