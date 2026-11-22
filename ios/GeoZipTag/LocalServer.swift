import Foundation
import Network

/// Serves the bundled web app on http://127.0.0.1 (loopback only).
/// Safari's engine only allows the camera and location on secure origins, and 127.0.0.1 counts as one;
/// a fixed port keeps the origin (and so the app's saved settings) the same on every launch.
final class LocalServer {
    static let preferredPort: UInt16 = 47653
    private static let csp = "default-src 'none'; script-src 'self'; style-src 'self'; "
        + "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; manifest-src 'self'; "
        + "connect-src 'self' blob: https://photon.komoot.io https://nominatim.openstreetmap.org https://*.arcgis.com; "
        + "frame-src 'none'; base-uri 'none'; form-action 'self'"
    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
        "woff2": "font/woff2", "webmanifest": "application/manifest+json", "txt": "text/plain; charset=utf-8",
    ]

    private var root: URL   // only touched on `queue`
    private let queue = DispatchQueue(label: "geoziptag.server")
    private var listener: NWListener?
    private var photos: [(id: String, data: Data)] = []   // the last few native camera photos, only touched on `queue`
    private(set) var port: UInt16 = 0

    init(root: URL) { self.root = root.standardizedFileURL }

    /// Makes a photo from the native camera available at /native-photo/<id>.jpg for the page to stamp.
    func putPhoto(_ id: String, _ data: Data) {
        queue.sync {
            photos.append((id, data))
            if photos.count > 3 { photos.removeFirst(photos.count - 3) }
        }
    }

    /// Serves another folder from now on (a wireless update that was just switched to).
    func setRoot(_ url: URL) {
        let standardized = url.standardizedFileURL
        queue.sync { root = standardized }
    }

    /// Starts listening and returns the port, or nil if no port could be opened.
    func start() -> UInt16? {
        for candidate in [Self.preferredPort, 0] {
            if let started = listen(on: candidate) { return started }
        }
        return nil
    }

    private func listen(on candidate: UInt16) -> UInt16? {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: candidate) ?? .any)
        guard let listener = try? NWListener(using: parameters) else { return nil }
        let ready = DispatchSemaphore(value: 0)
        var succeeded = false
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: succeeded = true; ready.signal()
            case .failed, .cancelled: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.handle(connection) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        guard succeeded, let actual = listener.port?.rawValue else { listener.cancel(); return nil }
        self.listener = listener
        port = actual
        return actual
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, _, _ in
            guard let self, let data else { connection.cancel(); return }
            let request = String(decoding: data, as: UTF8.self)
            let line = request.components(separatedBy: "\r\n").first ?? ""
            let parts = line.split(separator: " ")
            guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else {
                self.send(connection, status: "405 Method Not Allowed", type: "text/plain", body: Data())
                return
            }
            self.respond(connection, target: String(parts[1]), headOnly: parts[0] == "HEAD")
        }
    }

    private func respond(_ connection: NWConnection, target: String, headOnly: Bool) {
        var path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "/")
        if path == "/" { path = "/index.html" }
        if path.hasPrefix("/native-photo/") {
            let id = String(path.dropFirst("/native-photo/".count).dropLast(".jpg".count))
            if path.hasSuffix(".jpg"), let photo = photos.last(where: { $0.id == id }) {
                send(connection, status: "200 OK", type: "image/jpeg", body: photo.data, headOnly: headOnly)
            } else {
                send(connection, status: "404 Not Found", type: "text/plain", body: Data())
            }
            return
        }
        guard path.range(of: "^/[A-Za-z0-9._/-]{1,200}$", options: .regularExpression) != nil, !path.contains(".."), !path.contains("/.") else {
            send(connection, status: "400 Bad Request", type: "text/plain", body: Data())
            return
        }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"),
              let body = try? Data(contentsOf: file) else {
            send(connection, status: "404 Not Found", type: "text/plain", body: Data())
            return
        }
        let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        send(connection, status: "200 OK", type: type, body: body, headOnly: headOnly)
    }

    private func send(_ connection: NWConnection, status: String, type: String, body: Data, headOnly: Bool = false) {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
            + "Content-Security-Policy: \(Self.csp)\r\nX-Content-Type-Options: nosniff\r\n"
            + "Cache-Control: no-cache\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        if !headOnly { out.append(body) }
        connection.send(content: out, contentContext: .finalMessage, isComplete: true,
                        completion: .contentProcessed { _ in connection.cancel() })
    }
}
