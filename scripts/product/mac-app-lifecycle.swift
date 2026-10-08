import AppKit
import Darwin
import Foundation

func fail(_ message: String, status: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(status)
}

guard CommandLine.arguments.count == 4 else { fail("Usage: mac-app-lifecycle.swift terminate|launch APP_PATH BUILD") }
let action = CommandLine.arguments[1]
let app = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
let build = CommandLine.arguments[3]
let helper = app.appendingPathComponent("Contents/Library/LoginItems/Home23Host.app").standardizedFileURL
func matching(_ bundleID: String, _ path: URL) -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter {
        $0.bundleURL?.standardizedFileURL.path == path.path
    }
}
func hasExited(_ process: NSRunningApplication) -> Bool {
    if process.isTerminated { return true }
    // AppKit can retain isTerminated=false after a background login item has
    // exited. Require the OS to confirm that exact PID no longer exists; never
    // replace an app merely because it disappeared from the workspace list.
    return kill(process.processIdentifier, 0) == -1 && errno == ESRCH
}
func waitForExit(_ processes: [NSRunningApplication]) {
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
        if processes.allSatisfy(hasExited) { return }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    fail("A previous Home23 process did not exit; app was not replaced")
}
func launch(_ url: URL, id: String) {
    var launched: NSRunningApplication?
    var launchError: Error?
    let config = NSWorkspace.OpenConfiguration()
    if id == "com.home23.host" {
        config.arguments = ["--home23-background"]
        config.activates = false
    }
    NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
        launched = app
        launchError = error
    }
    let deadline = Date().addingTimeInterval(20)
    var finishedAt: Date?
    while Date() < deadline {
        if let process = launched {
            if hasExited(process) {
                // A launchd PID can exit while Gatekeeper is still scanning
                // the bundle (for example during container-cache maintenance).
                // Keep those bytes at their path; this is not permission to
                // restore another bundle or retry an unclassified exit.
                fail("Home23 exited before application startup finished", status: 75)
            }
            if process.isFinishedLaunching {
                if finishedAt == nil { finishedAt = Date() }
                if Date().timeIntervalSince(finishedAt!) >= 1 { break }
            } else { finishedAt = nil }
        }
        if launchError != nil { break }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    if let error = launchError {
        // A failed callback can arrive before the OS finishes its policy
        // assessment. Preserve the replacement and let Resume reassess it.
        fail("Home23 launch did not finish: \(error.localizedDescription)", status: 75)
    }
    guard let process = launched, process.isFinishedLaunching, !hasExited(process),
          let finished = finishedAt, Date().timeIntervalSince(finished) >= 1 else {
        fail("Home23 application startup is still pending", status: 75)
    }
    guard process.bundleIdentifier == id,
          process.bundleURL?.standardizedFileURL.path == url.path,
          let info = Bundle(url: url)?.infoDictionary,
          String(describing: info["CFBundleVersion"] ?? "") == build else {
        fail("Home23 did not launch the replacement bundle and build")
    }
    print("\(id) pid=\(process.processIdentifier) build=\(build) path=\(url.path)")
}

if action == "terminate" {
    let clients = matching("com.regina6.home23.mac", app)
    let helpers = matching("com.home23.host", helper)
    let processes = clients + helpers
    for process in processes where !process.terminate() {
        fail("Home23 declined graceful termination")
    }
    waitForExit(processes)
    print("terminated clients=\(clients.count) helpers=\(helpers.count)")
} else if action == "launch" {
    launch(app, id: "com.regina6.home23.mac")
    launch(helper, id: "com.home23.host")
} else {
    fail("Unknown lifecycle action")
}
