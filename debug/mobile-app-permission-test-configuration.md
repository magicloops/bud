# Debug: App permission test configuration

From `/Users/adam/bud-mobile`:

```sh
xcodebuild -project Bud.xcodeproj -scheme Bud -configuration Release -destination 'platform=iOS Simulator,id=BC8F97A1-47D7-416C-8682-4E4D7D342B9E' -only-testing:BudTests/AppDataPermissionTests test
```

Failed with:

```text
warning: ignore swiftmodule built without '-enable-testing'
BudTests/Support/MockChatBackend.swift:2:18: error: Compilation search paths unable to resolve module dependency: 'Bud'
@testable import Bud
** TEST FAILED **
```

The preceding standalone Release simulator application build succeeded. The test
command incorrectly selected the non-testable Release module. Use Debug for the
existing `@testable` test target; no app code or Release configuration change is
needed. Full original output: `/tmp/bud-app-permissions-tests.log`.
