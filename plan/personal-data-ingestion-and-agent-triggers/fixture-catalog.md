# Shared wire fixtures and validation boundaries

## Shared bytes

The canonical development fixture is
[`service/src/personal-data/wire-contract-v1.json`](../../service/src/personal-data/wire-contract-v1.json).
Its identical mobile copy is
[`TimelineCoreTests/wire-contract-v1.json`](../../../bud-mobile/TimelineCore/Tests/TimelineCoreTests/wire-contract-v1.json).
Both tests pin SHA-256:

`0e03793494fd91c453aa4f51d991777947430ff5d3794b042ecabe3463d75515`

Each checkout runs independently: SwiftPM bundles the mobile copy as a test-only
resource; the Node test reads its adjacent copy. Intentional changes require
reviewing both consumers, copying the same bytes and updating both pinned hashes.
Never populate this fixture with real personal data or credentials.

## What it proves

| Fixture | Service assertion | Mobile assertion |
|---|---|---|
| v1 location, opaque health and baseline contact record/manifest | Plain/gzip ingestion preserves every envelope; complete contact manifest verifies | `EventEnvelope` decode/encode preserves JSON fields, timestamps, nulls and Unicode |
| Full successful ACK | Real Fastify handler response matches fixture except dynamic server time; repository is injected | Decoder accepts the response and membership validation identifies all batch members |
| Partial/empty ACK | Examples describe valid explicit subsets; durable behavior tested separately | Exactly the stated subset is acknowledged, including no members for empty ACK |
| Wrong batch, foreign ID, duplicate ID, missing membership | Invalid mobile response examples, not service success outputs | Decode or membership validation rejects every example |

The health payload is deliberately opaque: this verifies raw envelope transport,
not HealthKit source semantics or health projection support. The service test
injects authentication and persistence; it does not prove OAuth or database
durability. The mobile test exercises production codecs, not OS background tasks.

## Separate behavioral fixtures

| Concern | Existing tests | Remaining evidence |
|---|---|---|
| Raw dedupe/conflict and atomic event/job writes | `repository.test.ts`, `parser.test.ts`, `routes.test.ts` | Actual public origin and mobile delivery |
| Split/reversed/incomplete scans, baseline suppression, repair | `contact-processor.test.ts`, `contact-repair.test.ts`, `ContactsSnapshotTests.swift` | Physical notification/permission behavior and lost local store identity |
| Account/queue/ACK recovery | `QueueRecoveryTests.swift`, `BackgroundQueueIdentityTests.swift`, `BackgroundUploaderLifetimeTests.swift`, `UploadAcknowledgementTests.swift` | Kill/lock/storage-full/cold-callback device matrix |
| Publication/activation/bootstrap cutover | `contact-processor.test.ts`, `automations.test.ts` | Live model and both-clients-closed execution |
| Protected approval/setup/replay | `app-keys.test.ts`, `app-key-backend.test.ts`, `invocation-app-data.test.ts` | Opposite-client approval, private viewer and live agent setup |

Those tests use additional language-specific fixtures; the shared corpus does
not yet replace every example. The full phase-0/phase-8 acceptance gates remain
open. The [validation checklist](validation-checklist.md) defines their scope.

## Latest verification

- Consolidated service/PostgreSQL run: 78 tests, no failures/skips,
  `/tmp/bud-personal-data-consolidated-tests.log`.
- TimelineCore iPhone 17 simulator run: 22 tests, no failures,
  `/tmp/bud-shared-wire-mobile-tests.log`.
- Direct byte comparison of both fixture copies and phase-document link checks
  run locally; no deployment is implied.

## Expanded contact corpus

`service/src/personal-data/wire-contract-v2.json` and the matching TimelineCoreTests
resource contain identical synthetic bytes, pinned by both language suites to:

`e69399c080d8bde576e4d3b5562a1e99f51a9a876afe816d4c7be1e771746b99`

The corpus includes Japanese and Canadian structured addresses, multiple labels,
Unicode/newlines, an original unsafe-scheme website string, observed-empty arrays
and a complete two-record baseline manifest. Service tests verify plain/gzip
preservation, explicit v2 parsing, legacy rejection and complete/incomplete
manifest membership. Swift tests verify codec round-trip and feeding those exact
fields through scan planning and upload-size validation without truncation or
new-contact eligibility. This does not exercise CNContactStore fetching or OS
background delivery; those still require device validation.

Shared v2 validation passed: two service wire tests
(`/tmp/bud-v2-shared-service-tests.log`), service build
(`/tmp/bud-v2-shared-service-build.log`), and two Swift wire tests
(`/tmp/bud-v2-shared-mobile-tests-final.log`). Both fixture copies are byte-identical.
Swift required fresh test packaging after an incremental build retained an older
embedded resource bundle; see `debug/contact-v2-fixture-resource.md` in the main
repo. This proves codec/planner/parser compatibility, not physical capture.
