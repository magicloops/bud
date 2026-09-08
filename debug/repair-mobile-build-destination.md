# Debug: Repair UI build destination typo

The build was invoked with simulator ID
`905B18E9-A744-40E2-B0C4-63B341E5D5D5BC` instead of
`905B18E9-A744-40E2-B0C4-63B341E5D5BC`.

Command: `xcodebuild build -project Bud.xcodeproj -scheme Bud -configuration Debug -destination 'platform=iOS Simulator,id=905B18E9-A744-40E2-B0C4-63B341E5D5D5BC'`

It was waiting for the nonexistent destination. Confirmed process 53182 using
`pgrep -fl 'xcodebuild build'`, then terminated that specific invocation before
running the corrected command. This was a command typo, not an app compile error.
Output was redirected to `/tmp/bud-repair-mobile-build.log`.
