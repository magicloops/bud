# Debug: V2 upload fixture session initialization

The TimelineCore ContactsSnapshotTests command recorded in
`/tmp/bud-contact-v2-upload-gate-tests.log` crashed in
`BackgroundUploader.swift:97`: `Fatal error: Unexpectedly found nil while
unwrapping an Optional value`.

The new fixture called `SyncEngine.performSync` with an uploader constructed
using `connectImmediately: false`. Recovery queries active URLSession tasks,
which requires connected sessions, as the real manager provides before kicking
sync. Correct the fixture to connect the sessions; the capability rejection
still occurs before enqueue and must never request upload credentials. Verify
unchanged queued event bytes/IDs/checkpoint and no in-flight batch after failure.

The rerun then caught a fixture byte comparison against a second JSONEncoder
encoding, whose key order is not guaranteed. Capture the original checkpoint
bytes once and compare storage against exactly those bytes. Log:
`/tmp/bud-contact-v2-upload-gate-tests-rerun.log`, line-235 assertion comparing
two different 199-byte values. Event byte/ID preservation assertions passed.
