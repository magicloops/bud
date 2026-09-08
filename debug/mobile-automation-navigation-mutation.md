# Debug: Automation editor navigation replay

SwiftUI restarts a view task on reappearance. Retaining the previous save/pause
operation in view state would repeat that mutation after returning from history.
Capture each operation once and reset the pending action to load before awaiting.
The creation retry payload remains separate and requires an explicit retry button.
Release build and DTO tests passed; incremental simulator build validates the fix.
