# Debug: TimelineCore test scheme unavailable

## Environment and command

Working directory: `/Users/adam/bud-mobile`. Xcode resolved TimelineCore as a local package. Available iOS 26.2 simulator: iPhone 17.

```sh
xcodebuild test -project Bud.xcodeproj -scheme TimelineCore -destination 'platform=iOS Simulator,id=905B18E9-A744-40E2-B0C4-63B341E5D5BC' -only-testing:TimelineCoreTests -resultBundlePath /tmp/bud-personal-data-timelinecore-tests.xcresult > /tmp/bud-personal-data-timelinecore-tests.log 2>&1
```

Exit code: 66. Exact output:

```text
Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -project Bud.xcodeproj -scheme TimelineCore -destination "platform=iOS Simulator,id=905B18E9-A744-40E2-B0C4-63B341E5D5BC" "-only-testing:TimelineCoreTests" -resultBundlePath /tmp/bud-personal-data-timelinecore-tests.xcresult

Resolve Package Graph


Resolved source packages:
  textual: https://github.com/gonzalezreal/textual @ 0.3.1
  TimelineCore: /Users/adam/bud-mobile/TimelineCore
  StreamingMarkdown: /Users/adam/bud-mobile/Packages/StreamingMarkdown
  swiftui-math: https://github.com/gonzalezreal/swiftui-math @ 0.1.0
  swift-concurrency-extras: https://github.com/pointfreeco/swift-concurrency-extras @ 1.3.2

xcodebuild: error: Scheme TimelineCore is not currently configured for the test action.


```

## Status

Test configuration failed before compilation/execution. No mobile test passed or failed an assertion. Stopped per AGENTS.md §3.5 without trying an alternative command or scheme.

Mobile working-tree changes: `UploadAcknowledgement.swift` requires matching batch identity and an explicit unique ACK list; uploader rejects empty/malformed success and propagates retry hints; SyncEngine checks durable batch membership before deletion and releases enqueue failures. New `UploadAcknowledgementTests.swift` covers those response/membership contracts. Full phase-2 account partition/OAuth/recovery and later phases remain unfinished.

Next step: configure a testable TimelineCore package scheme or add package tests to the app's test plan, then run the tests and simulator build. This requires human direction under the repository failure rule.

## Resolution

Run package tests from `/Users/adam/bud-mobile/TimelineCore` using the standalone package workspace, omitting `-project Bud.xcodeproj`. The dependency scheme in the app project has no test action; the package workspace does. The standalone command passed all five tests, including three strict-ACK cases. Subsequent queue/account code also compiled and passed those tests; new targeted recovery tests are next.
