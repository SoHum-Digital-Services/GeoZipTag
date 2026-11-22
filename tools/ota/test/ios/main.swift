// Tests ios/GeoZipTag/OtaUpdater.swift against a real signed update served over HTTP (see run.sh).
import Foundation

let args = CommandLine.arguments
let server = URL(string: args[1])!                  // http://127.0.0.1:PORT/
let key = try! String(contentsOfFile: args[2])       // matching public key (base64 SPKI)
let wrongKey = try! String(contentsOfFile: args[3])  // some other key
let bundleWeb = URL(fileURLWithPath: args[4])        // the web files built into the app
let work = URL(fileURLWithPath: args[5])
var failures = 0, count = 0

func check(_ label: String, _ condition: Bool, _ detail: String = "") {
    count += 1
    if !condition { failures += 1 }
    print("\(condition ? "PASS" : "FAIL") \(label)\(detail.isEmpty ? "" : " | \(detail)")")
}

var rootNumber = 0
func updater(site: String = "good/ota/", key: String = key, build: Int64 = 11, bundled: Int64 = 1) -> OtaUpdater {
    rootNumber += 1
    return OtaUpdater(root: work.appendingPathComponent("root\(rootNumber)"), bundleWeb: bundleWeb,
                      base: server.appendingPathComponent(site), publicKeyBase64: key,
                      appBuild: build, bundledVersion: bundled, bundledLabel: "bundled")
}

let published = try! String(contentsOf: server.appendingPathComponent("good/ota/manifest.txt"))
let label = published.split(separator: "\n").first { $0.hasPrefix("label ") }!.dropFirst(6)
let index = try! Data(contentsOf: server.appendingPathComponent("good/ota/files/index.html"))

// Happy path
let u = updater()
check("starts on the built-in files", u.prepareForLaunch() == bundleWeb && u.activeLabel == "bundled")
var status = await u.check()
check("finds and downloads the update", status.state == "ready" && status.detail == label, "\(status)")
check("update waits until the next launch", u.pendingLabel == String(label) && u.activeLabel == "bundled")
status = await u.check()
check("checking again keeps the waiting update", status.state == "ready")
var served = u.prepareForLaunch()
check("next launch serves the update", served != bundleWeb && (try? Data(contentsOf: served.appendingPathComponent("index.html"))) == index)
check("labels after switching", u.activeLabel == String(label) && u.pendingLabel == nil)
check("metadata is a dot file (never served)", FileManager.default.fileExists(atPath: served.appendingPathComponent(OtaUpdater.metaName).path))
status = await u.check()
check("then it is current", status.state == "current", "\(status)")
u.confirm()
for _ in 0..<4 { served = u.prepareForLaunch() }
check("a confirmed update survives many launches", served != bundleWeb)

// Rollback of an update whose page never starts
let r = updater()
_ = await r.check()
var launches: [Bool] = []
for _ in 0..<3 { launches.append(r.prepareForLaunch() != bundleWeb) }
check("an unconfirmed update gets two tries, then rolls back", launches == [true, true, false], "\(launches)")
status = await r.check()
check("a rolled-back version is never downloaded again", status.state == "current", "\(status)")

// Refusals
status = await updater(build: 1).check()
check("an update needing a newer app is refused", status.state == "needs-app", "\(status)")
status = await updater(bundled: Int64.max - 1).check()
check("an older update than the built-in files is ignored", status.state == "current", "\(status)")
let w = updater(key: wrongKey)
status = await w.check()
check("a list signed with another key is refused", status.state == "error" && w.pendingLabel == nil, "\(status)")
let t = updater(site: "tampered/ota/")
status = await t.check()
check("an edited update list is refused", status.state == "error" && t.pendingLabel == nil, "\(status)")
let f = updater(site: "badfile/ota/")
status = await f.check()
check("a file that does not match its hash is refused", status.state == "error" && f.pendingLabel == nil, "\(status)")
check("nothing is switched to after a refusal", f.prepareForLaunch() == bundleWeb)
status = await updater(site: "missing/ota/").check()
check("an unreachable server is an error, not a crash", status.state == "error")
status = await updater(key: "not a key").check()
check("a broken key disables updates", status.state == "error")

print("\n\(count - failures) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
