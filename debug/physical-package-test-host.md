# Debug: Standalone Swift package tests require an iOS host

The user unlocked the iPhone. A first CoreDevice connection was reset; refreshing
device discovery and retrying the same app lookup succeeded. Developer services
mounted successfully. Production `chat.bud.app` is installed; no
`chat.bud.app.local` build was installed at inspection.

From `bud-mobile/TimelineCore`:

```sh
xcodebuild test -scheme TimelineCore -destination 'platform=iOS,id=00008150-000971AA0EBA401C' DEVELOPMENT_TEAM=W3EC86FD96
```

Failed with exit 70:

> Cannot test target “TimelineCoreTests” on “iPhone (4)”: Tool-hosted testing is unavailable on device destinations. Select a host application for the test target, or use a simulator destination instead.

Log: `/tmp/bud-physical-timeline-tests.log`.

The existing `BudTests` target has `TEST_HOST` set to Bud.app, and the current
shared Bud scheme includes it. Use this existing host to run the personal-data
and app-permission contract tests on the phone. This is distinct from running
the entire standalone TimelineCore suite, which remains simulator-verified.
Neither establishes background delivery or real authenticated ingestion.

The initial app-hosted invocation (`xcodebuild test -project Bud.xcodeproj
-scheme Bud -configuration Debug -destination 'platform=iOS,id=00008150-000971AA0EBA401C'
-only-testing:BudTests/PersonalDataContractTests -only-testing:BudTests/AppDataPermissionTests`)
failed with exit 65: no provisioning profile for
`chat.bud.appUITests.xctrunner`; automatic profile generation was disabled.
Log: `/tmp/bud-physical-contract-tests.log`.

Use a temporary workspace referencing the original project with a copied scheme
whose Testables contains only BudTests. This removes the unrelated UI-test runner
from the build graph without changing shared schemes or provisioning new profiles.

## Verified result

The temporary `DeviceContracts.xcworkspace` / `DeviceContracts` scheme succeeded
on the physical iPhone with exit 0. All seven selected tests passed: four
`PersonalDataContractTests` and three `AppDataPermissionTests`. The Debug host
uses `chat.bud.app.local`; the production app remains separate.
Log: `/tmp/bud-physical-hosted-contract-tests.log`.

This establishes app-hosted DTO/consent/evidence contract behavior on device.
It does not establish real Contacts observation, background delivery, authenticated
API ingestion or live Bud/model execution. Those require a reachable API origin
and selected Bud/model; development localhost URLs cannot reach the Mac directly
from the phone.
