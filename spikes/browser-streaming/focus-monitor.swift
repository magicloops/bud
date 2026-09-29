// Read-only macOS foreground telemetry. Does not activate or inspect app content.
import AppKit
import Foundation

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "60") ?? 60
guard seconds >= 1 && seconds <= 300 else { exit(1) }
let start = Date()
var previous: pid_t? = nil
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    if pid != previous {
        let event: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "frontmost_pid": Int(pid)]
        let data = try! JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data([10]))
        previous = pid
    }
}
RunLoop.main.run(until: start.addingTimeInterval(seconds))
timer.invalidate()
