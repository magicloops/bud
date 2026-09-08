# Debug: Shared v2 fixture missing from incremental test bundle

## Environment and reproduction

From `/Users/adam/bud-mobile/TimelineCore`:
`xcodebuild test -scheme TimelineCore -destination 'platform=iOS Simulator,id=905B18E9-A744-40E2-B0C4-63B341E5D5BC' -only-testing:TimelineCoreTests/SharedWireContractTests -parallel-testing-enabled NO`

Log: `/tmp/bud-v2-shared-mobile-tests.log`.

## Observed

```
SharedWireContractTests.swift:43: error: -[TimelineCoreTests.SharedWireContractTests testSharedExpandedFieldsSurviveCodecAndScanPlanning] : XCTUnwrap failed: expected non-nil value of type "URL"
Executed 2 tests, with 1 failure
** TEST FAILED **
```

The build's resource-copy step included wire-contract-v2.json in the standalone
resource bundle. The existing nested bundle inside TimelineCoreTests.xctest
contained only wire-contract-v1.json, shadowing the new resource. Package.swift
correctly lists both files.

## Proposed fix

Run the same selected tests with a fresh task-specific derived-data directory to
rebuild the test packaging. Do not add a source-tree fallback or weaken the bundled
resource test; each checkout must run independently.
