import CryptoKit
import Foundation

/// Wireless updates of the web part, from the same signed update the Android app uses (tools/ota/README.md).
/// The update list is signed with ECDSA P-256; the public key ships inside the app, and every file is checked
/// against the SHA-256 in that list. A downloaded update waits in "pending" and is switched to on the next page
/// load; a version whose page never reports a successful start is rolled back after two tries and never retried.
final class OtaUpdater: @unchecked Sendable {
    static let defaultURL = URL(string: "https://sohum-digital-services.github.io/GeoZipTag/ota/")!
    static let previewURL = URL(string: "https://sohum-digital-services.github.io/GeoZipTag/preview/ota/")!
    private static let webPath = try! NSRegularExpression(pattern:
        "^(index\\.html|style\\.css|camera\\.js|manifest\\.webmanifest|vendor/qrcode\\.(mjs|txt)|vendor/qrcode-LICENSE\\.txt"
        + "|vendor/tz-lookup\\.js|vendor/tz-lookup-LICENSE\\.txt|vendor/pdf\\.(min|worker\\.min)\\.js|vendor/pdf-LICENSE\\.txt|assets/[a-z0-9-]{1,60}\\.(svg|woff2|jpg|png|txt))$")
    private static let labelPattern = try! NSRegularExpression(pattern: "^[0-9A-Za-z._-]{1,32}$")
    private static let hexPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")
    private static let maxFiles = 100, maxFile = 8 * 1024 * 1024, maxTotal = 24 * 1024 * 1024
    private static let attemptsBeforeRollback = 2
    static let metaName = ".update.json"   // inside an update folder; the local server never serves dot files

    struct Status { let state: String; let detail: String }   // ready | current | needs-app | error
    private struct Meta: Codable { var version: Int64; var label: String }
    private struct State: Codable { var version: Int64 = 0; var label = ""; var confirmed = true; var launches = 0; var bad: [Int64] = [] }
    private struct Entry { let sha: String; let size: Int; let path: String }
    private struct Manifest { var version: Int64 = 0; var label = ""; var minApp: Int64 = 0; var files: [Entry] = [] }
    private struct Failure: Error { let text: String }

    private let root: URL, bundleWeb: URL, base: URL
    private let key: P256.Signing.PublicKey?
    private let appBuild: Int64, bundledVersion: Int64
    let bundledLabel: String
    private let lock = NSLock()
    private var checking = false
    private let fm = FileManager.default
    private var active: URL { root.appendingPathComponent("active", isDirectory: true) }
    private var pending: URL { root.appendingPathComponent("pending", isDirectory: true) }
    private var staging: URL { root.appendingPathComponent("staging", isDirectory: true) }
    private var stateFile: URL { root.appendingPathComponent("state.json") }

    init(root: URL, bundleWeb: URL, base: URL = OtaUpdater.defaultURL, publicKeyBase64: String?,
         appBuild: Int64, bundledVersion: Int64, bundledLabel: String) {
        self.root = root
        self.bundleWeb = bundleWeb
        self.base = base
        self.appBuild = appBuild
        self.bundledVersion = bundledVersion
        self.bundledLabel = bundledLabel
        let der = publicKeyBase64.flatMap { Data(base64Encoded: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        key = der.flatMap { try? P256.Signing.PublicKey(derRepresentation: $0) }
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    var available: Bool { key != nil }

    // MARK: Launch, confirm, labels

    /// Switches to a waiting update, rolls back one that keeps failing, and returns the folder to serve.
    func prepareForLaunch() -> URL {
        lock.lock(); defer { lock.unlock() }
        var state = loadState()
        if let meta = readMeta(pending) {
            try? fm.removeItem(at: active)
            if (try? fm.moveItem(at: pending, to: active)) != nil {
                state = State(version: meta.version, label: meta.label, confirmed: false, launches: 0, bad: state.bad)
            } else {
                try? fm.removeItem(at: pending)
            }
        }
        if fm.fileExists(atPath: active.path) {
            if state.version <= bundledVersion || readMeta(active) == nil {
                try? fm.removeItem(at: active)   // the app itself now carries newer files
                state = State(bad: state.bad)
            } else if !state.confirmed {
                state.launches += 1
                if state.launches > Self.attemptsBeforeRollback {
                    try? fm.removeItem(at: active)
                    state = State(bad: state.bad + [state.version])
                }
            }
        } else {
            state = State(bad: state.bad)
        }
        saveState(state)
        return fm.fileExists(atPath: active.appendingPathComponent("index.html").path) ? active : bundleWeb
    }

    /// The page started properly.
    func confirm() {
        lock.lock(); defer { lock.unlock() }
        var state = loadState()
        guard state.version > 0, !state.confirmed else { return }
        state.confirmed = true
        state.launches = 0
        saveState(state)
    }

    var activeLabel: String {
        lock.lock(); defer { lock.unlock() }
        let state = loadState()
        return state.version > 0 && fm.fileExists(atPath: active.path) ? state.label : bundledLabel
    }

    var pendingLabel: String? {
        lock.lock(); defer { lock.unlock() }
        return readMeta(pending)?.label
    }

    // MARK: Checking and downloading

    func check() async -> Status {
        guard let key else { return Status(state: "error", detail: "Updates are not available in this build.") }
        lock.lock()
        if checking { lock.unlock(); return Status(state: "checking", detail: "") }
        checking = true
        lock.unlock()
        defer { lock.lock(); checking = false; lock.unlock() }
        do {
            let list = try await get("manifest.txt", limit: 256 * 1024)
            let signatureText = String(decoding: try await get("manifest.txt.sig", limit: 4096), as: UTF8.self)
            guard let raw = Data(base64Encoded: signatureText.trimmingCharacters(in: .whitespacesAndNewlines)),
                  let signature = try? P256.Signing.ECDSASignature(derRepresentation: raw),
                  key.isValidSignature(signature, for: list) else {
                return Status(state: "error", detail: "The update could not be verified.")
            }
            let manifest = try parse(list)

            lock.lock()
            let state = loadState()
            let current = state.version > 0 && fm.fileExists(atPath: active.path) ? state.version : bundledVersion
            let waiting = readMeta(pending)
            let serving = fm.fileExists(atPath: active.appendingPathComponent("index.html").path) ? active : bundleWeb
            lock.unlock()

            if let waiting, waiting.version >= manifest.version { return Status(state: "ready", detail: waiting.label) }
            if manifest.version <= current || state.bad.contains(manifest.version) { return Status(state: "current", detail: "") }
            if manifest.minApp > appBuild { return Status(state: "needs-app", detail: "") }

            try? fm.removeItem(at: staging)
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            for file in manifest.files {
                let target = staging.appendingPathComponent(file.path)
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                var data = try? Data(contentsOf: serving.appendingPathComponent(file.path))
                if data == nil || data!.count != file.size || Self.sha256(data!) != file.sha {
                    data = try await get("files/" + file.path, limit: file.size + 1)
                    guard data!.count == file.size, Self.sha256(data!) == file.sha else {
                        throw Failure(text: "A downloaded file did not match the update list.")
                    }
                }
                try data!.write(to: target)
            }
            try JSONEncoder().encode(Meta(version: manifest.version, label: manifest.label))
                .write(to: staging.appendingPathComponent(Self.metaName))

            lock.lock(); defer { lock.unlock() }
            try? fm.removeItem(at: pending)
            try fm.moveItem(at: staging, to: pending)
            return Status(state: "ready", detail: manifest.label)
        } catch let failure as Failure {
            try? fm.removeItem(at: staging)
            return Status(state: "error", detail: failure.text)
        } catch {
            try? fm.removeItem(at: staging)
            return Status(state: "error", detail: "")
        }
    }

    private func get(_ path: String, limit: Int) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure(text: "") }
        guard data.count <= limit else { throw Failure(text: "The update is larger than expected.") }
        return data
    }

    /// Format: geoziptag-ota 1 / version N / label TEXT / min-apk N / file SHA256 SIZE PATH ...
    /// min-apk is the native app's build number, shared by the Android version code and the iOS build.
    private func parse(_ data: Data) throws -> Manifest {
        let lines = String(decoding: data, as: UTF8.self).components(separatedBy: "\n")
        guard lines.count >= 5, lines[0] == "geoziptag-ota 1" else { throw Failure(text: "Unknown update format.") }
        var manifest = Manifest()
        var haveVersion = false, haveLabel = false, haveMin = false, total = 0
        var seen = Set<String>()
        for line in lines.dropFirst() where !line.isEmpty {
            let part = line.components(separatedBy: " ")
            if part[0] == "version", part.count == 2, !haveVersion, let value = Int64(part[1]), value > 0 {
                manifest.version = value; haveVersion = true
            } else if part[0] == "label", part.count == 2, !haveLabel, Self.matches(Self.labelPattern, part[1]) {
                manifest.label = part[1]; haveLabel = true
            } else if part[0] == "min-apk", part.count == 2, !haveMin, let value = Int64(part[1]), value >= 0 {
                manifest.minApp = value; haveMin = true
            } else if part[0] == "file", part.count == 4, let size = Int(part[2]), size >= 0, size <= Self.maxFile,
                      Self.matches(Self.hexPattern, part[1]), Self.matches(Self.webPath, part[3]),
                      !seen.contains(part[3]), seen.count < Self.maxFiles {
                seen.insert(part[3])
                total += size
                manifest.files.append(Entry(sha: part[1], size: size, path: part[3]))
            } else {
                throw Failure(text: "The update list is invalid.")
            }
        }
        guard haveVersion, haveLabel, haveMin, seen.contains("index.html"), total <= Self.maxTotal else {
            throw Failure(text: "The update list is incomplete.")
        }
        return manifest
    }

    // MARK: Helpers

    private static func matches(_ pattern: NSRegularExpression, _ text: String) -> Bool {
        pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func readMeta(_ folder: URL) -> Meta? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(Self.metaName)),
              let meta = try? JSONDecoder().decode(Meta.self, from: data),
              fm.fileExists(atPath: folder.appendingPathComponent("index.html").path) else { return nil }
        return meta
    }

    private func loadState() -> State {
        guard let data = try? Data(contentsOf: stateFile), let state = try? JSONDecoder().decode(State.self, from: data) else { return State() }
        return state
    }

    private func saveState(_ state: State) {
        try? JSONEncoder().encode(state).write(to: stateFile, options: .atomic)
    }
}
