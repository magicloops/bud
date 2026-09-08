# Debug: mobile location view compile failure

Command from `/Users/adam/bud-mobile`:
```
xcodebuild test -project Bud.xcodeproj -scheme Bud -configuration Debug -destination 'platform=iOS Simulator,id=905B18E9-A744-40E2-B0C4-63B341E5D5BC' -only-testing:BudTests/PersonalDataContractTests -resultBundlePath /tmp/bud-location-grant-tests-0904b.xcresult > /tmp/bud-location-grant-tests-0904b.log 2>&1
```

Swift reported at `PersonalDataView.swift:294:79`:
```
error: cannot assign to value: 'error' is immutable
error: cannot assign value of type 'Bool' to type 'any Error'
```

The implicit caught `error` shadows the view state. Assign `self.error`. Also make the wire DTOs explicitly nonisolated/Sendable so concurrent API decoding does not depend on the app's default MainActor isolation. Rebuild and run the focused contract tests.
