import AppKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
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
func waitForExit(_ processes: [NSRunningApplication]) {
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
        if processes.allSatisfy({ $0.isTerminated }) { return }
        Thread.sleep(forTimeInterval: 0.1)
    }
    fail("A previous Home23 process did not exit; app was not replaced")
}
func launch(_ url: URL, id: String) {
    var launched: NSRunningApplication?
    var launchError: Error?
    let config = NSWorkspace.OpenConfiguration()
    NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
        launched = app
        launchError = error
    }
    let deadline = Date().addingTimeInterval(20)
    while launched == nil && launchError == nil && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    if let error = launchError { fail("Home23 launch failed: \(error.localizedDescription)") }
    guard let process = launched, !process.isTerminated,
          process.bundleIdentifier == id,
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
