import AVFoundation
import AVKit
import CoreLocation
import Photos
import UIKit
import WebKit

/// Hosts the GeoZipTag web app and gives it the same native features the Android app has:
/// automatic saving into a "GeoZipTag" album in Photos, deleting, sharing, address lookup and report printing.
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private static let albumName = "GeoZipTag"
    private static let maxPayload = 40_000_000   // base64 characters, about 30 MB of photo

    // The page was written for the Android app and talks to `window.AndroidHost`; this is the iOS version of it.
    private static let shim = """
    (() => {
      const post = (message) => window.webkit.messageHandlers.host.postMessage(message)
      const info = window.__geoZipTagUpdateInfo || {}
      window.AndroidHost = {
        updateInfo: () => JSON.stringify(info),
        checkForUpdates: () => post({ type: 'checkForUpdates' }),
        applyUpdate: () => post({ type: 'applyUpdate' }),
        otaConfirm: () => post({ type: 'otaConfirm' }),
        hasLocationAccess: () => true,
        cameraStart: (facing) => post({ type: 'cameraStart', facing: String(facing) }),
        cameraStop: () => post({ type: 'cameraStop' }),
        cameraSet: (json) => post({ type: 'cameraSet', settings: JSON.parse(json) }),
        cameraFocus: (x, y) => post({ type: 'cameraFocus', x: Number(x), y: Number(y) }),
        cameraLayout: (x, y, w, h) => post({ type: 'cameraLayout', x: Number(x), y: Number(y), w: Number(w), h: Number(h) }),
        cameraCapture: (id) => post({ type: 'cameraCapture', id: String(id) }),
        setVolumeShutter: window.__geoZipTagVolumeButtons ? (on) => post({ type: 'setVolumeShutter', on: !!on }) : undefined,
        exportPhoto: (action, filename, data) => post({ type: 'exportPhoto', action, filename, data }),
        deletePhoto: (filename) => post({ type: 'deletePhoto', filename }),
        reverseGeocode: (id, lat, lon) => post({ type: 'reverseGeocode', id, lat, lon }),
        printReport: (html) => post({ type: 'printReport', html }),
      }
    })()
    """

    private var webView: WKWebView!
    private let camera = NativeCamera()
    private var volumeInteraction: UIInteraction?
    private var server: LocalServer?
    private var updater: OtaUpdater?
    private var lastUpdateCheck = Date.distantPast
    private let locationManager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var savedAssets: [String: String] = [:]          // file name -> Photos asset id, this session only
    private var lastSave: Task<Void, Never> = Task {}        // saves run one after another
    private var toast: UILabel?
    private var printer: ReportPrinter?
    private var savedOnce = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.add(WeakHandler(self), name: "host")
        configuration.userContentController = controller

        // The camera preview sits behind the page; the page is transparent where the preview shows.
        camera.previewView.frame = view.bounds
        camera.previewView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        camera.previewView.isHidden = true
        view.addSubview(camera.previewView)

        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        view.addSubview(webView)

        locationManager.requestWhenInUseAuthorization()
        startServerAndLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(enteredForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func enteredForeground() { checkForUpdates(manual: false) }

    /// The page reads update details synchronously, so they are injected before each load.
    private func installShim() {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        var info: [String: Any] = ["app": "\(Self.bundleValue("CFBundleShortVersionString")) (iOS)", "updates": updater?.available == true]
        info["web"] = updater?.activeLabel ?? ""
        let pending = updater?.pendingLabel
        info["pending"] = pending != nil
        info["pendingLabel"] = pending ?? ""
        let data = (try? JSONSerialization.data(withJSONObject: info)) ?? Data("{}".utf8)
        var volumeButtons = false
        if #available(iOS 17.2, *) { volumeButtons = true }
        let script = "window.__geoZipTagUpdateInfo = \(String(decoding: data, as: UTF8.self));\n"
            + "window.__geoZipTagVolumeButtons = \(volumeButtons);\n" + Self.shim
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private static func bundleValue(_ key: String) -> String {
        Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
    }

    private static func bundleText(_ name: String) -> String? {
        guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private func makeUpdater(web: URL) -> OtaUpdater? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        // ota-version.txt (written at build time): the version and label of the web files inside the app.
        let stamp = (Self.bundleText("ota-version.txt") ?? "").split(separator: "\n").map(String.init)
        return OtaUpdater(root: support.appendingPathComponent("ota", isDirectory: true), bundleWeb: web,
                          publicKeyBase64: Self.bundleText("ota-public-key.b64"),
                          appBuild: Int64(Self.bundleValue("CFBundleVersion")) ?? 0,
                          bundledVersion: stamp.first.flatMap { Int64($0) } ?? 0,
                          bundledLabel: stamp.count > 1 ? stamp[1] : "built in")
    }

    private func checkForUpdates(manual: Bool) {
        guard let updater else {
            if manual { callPage("window.onOtaStatus && window.onOtaStatus('error', 'Updates are not available in this build.')") }
            return
        }
        if !manual && Date().timeIntervalSince(lastUpdateCheck) < 30 * 60 { return }
        lastUpdateCheck = Date()
        if manual { callPage("window.onOtaStatus && window.onOtaStatus('checking', '')") }
        Task { [weak self] in
            let status = await updater.check()
            guard let self, manual || status.state == "ready" else { return }
            self.callPage("window.onOtaStatus && window.onOtaStatus(\(Self.js(status.state)), \(Self.js(status.detail)))")
        }
    }

    private func applyUpdate() {
        guard let updater, let server else { return }
        server.setRoot(updater.prepareForLaunch())
        installShim()
        webView.reload()
    }

    private func startServerAndLoad() {
        guard let web = Bundle.main.url(forResource: "web", withExtension: nil) else {
            showStartupError("The app's web files are missing.")
            return
        }
        updater = makeUpdater(web: web)
        let server = LocalServer(root: updater?.prepareForLaunch() ?? web)
        guard let port = server.start() else {
            showStartupError("Could not start the app.")
            return
        }
        self.server = server
        installShim()
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/index.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.checkForUpdates(manual: false) }
    }

    private func showStartupError(_ text: String) {
        let label = UILabel(frame: view.bounds.insetBy(dx: 24, dy: 24))
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        label.text = text
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        view.addSubview(label)
    }

    /// Volume up/down take a photo (Apple's capture-button support; it works while the camera is running).
    private func setVolumeShutter(_ on: Bool) {
        guard #available(iOS 17.2, *) else { return }
        if on, volumeInteraction == nil {
            let interaction = AVCaptureEventInteraction { [weak self] event in
                if event.phase == .began { self?.callPage("window.onHardwareShutter && window.onHardwareShutter()") }
            }
            view.addInteraction(interaction)
            volumeInteraction = interaction
        } else if !on, let interaction = volumeInteraction {
            view.removeInteraction(interaction)
            volumeInteraction = nil
        }
    }

    private func currentOrientation() -> AVCaptureVideoOrientation {
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        case .portraitUpsideDown: return .portraitUpsideDown
        default: return .portrait
        }
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self else { return }
            self.camera.setPreviewOrientation(self.currentOrientation())
        }
    }

    // MARK: Web view behaviour

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.host != "127.0.0.1", url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)   // links to other sites open in Safari, never inside the app
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    // The camera permission is asked once by iOS; the page is our own, so never ask a second time.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)
    }

    // The level in Camera settings reads the motion sensor; the page is our own, so allow it.
    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()   // iOS can stop the page's process in the background
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "exportPhoto":
            guard let action = body["action"] as? String, let filename = body["filename"] as? String,
                  let encoded = body["data"] as? String, Self.validName(filename), encoded.count <= Self.maxPayload,
                  action == "save" || action == "share",
                  let data = Data(base64Encoded: encoded), data.count > 3, data[0] == 0xff, data[1] == 0xd8 else {
                showToast("Could not export this photo.")
                return
            }
            if action == "share" { share(filename: filename, data: data) } else { enqueueSave(filename: filename, data: data) }
        case "deletePhoto":
            if let filename = body["filename"] as? String, Self.validName(filename) { enqueueDelete(filename: filename) }
        case "reverseGeocode":
            if let id = body["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil,
               let lat = body["lat"] as? Double, let lon = body["lon"] as? Double,
               abs(lat) <= 90, abs(lon) <= 180 {
                lookUp(id: id, lat: lat, lon: lon)
            }
        case "cameraStart":
            let facing = (body["facing"] as? String) == "user" ? "user" : "environment"
            camera.setPreviewOrientation(currentOrientation())
            camera.start(facing: facing) { [weak self] result in
                guard let self else { return }
                self.camera.previewView.isHidden = result["ok"] as? Bool != true
                let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)
                self.callPage("window.onNativeCamera && window.onNativeCamera(\(String(decoding: data, as: UTF8.self)))")
            }
        case "cameraStop":
            camera.stop()
            camera.previewView.isHidden = true
        case "cameraSet":
            let settings = body["settings"] as? [String: Any] ?? [:]
            camera.set(zoom: (settings["zoom"] as? NSNumber)?.doubleValue, torch: settings["torch"] as? Bool,
                       flash: settings["flash"] as? String, exposure: (settings["exposure"] as? NSNumber)?.doubleValue)
        case "cameraFocus":
            if let x = (body["x"] as? NSNumber)?.doubleValue, let y = (body["y"] as? NSNumber)?.doubleValue {
                camera.focus(at: webView.convert(CGPoint(x: x, y: y), to: camera.previewView))   // preview-local point
            }
        case "cameraLayout":
            // The page's camera area (CSS pixels = points): the preview fills exactly the photo's frame.
            if let x = (body["x"] as? NSNumber)?.doubleValue, let y = (body["y"] as? NSNumber)?.doubleValue,
               let w = (body["w"] as? NSNumber)?.doubleValue, let h = (body["h"] as? NSNumber)?.doubleValue, w > 0, h > 0 {
                camera.previewView.autoresizingMask = []
                camera.previewView.frame = webView.convert(CGRect(x: x, y: y, width: w, height: h), to: view)
            }
        case "cameraCapture":
            guard let id = body["id"] as? String, id.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil else { return }
            camera.capture(orientation: currentOrientation()) { [weak self] data in
                guard let self else { return }
                if let data { self.server?.putPhoto(id, data) }
                self.callPage("window.onNativePhoto && window.onNativePhoto(\(Self.js(id)), \(data != nil))")
            }
        case "setVolumeShutter":
            setVolumeShutter(body["on"] as? Bool == true)
        case "checkForUpdates": checkForUpdates(manual: true)
        case "applyUpdate": applyUpdate()
        case "otaConfirm": updater?.confirm()
        case "printReport":
            if let html = body["html"] as? String, html.count <= Self.maxPayload { printReport(html) }
            else { showToast("This report is too large. Use smaller photos.") }
        default: break
        }
    }

    private static func validName(_ name: String) -> Bool {
        name.range(of: "^GeoZipTag-[A-Za-z0-9_-]{1,95}\\.jpg$", options: .regularExpression) != nil
    }

    private func callPage(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private static func js(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return String(text.dropFirst().dropLast())
    }

    // MARK: Saving to Photos

    private func enqueueSave(filename: String, data: Data) {
        let previous = lastSave
        lastSave = Task { [weak self] in
            await previous.value
            await self?.save(filename: filename, data: data)
        }
    }

    private func save(filename: String, data: Data) async {
        guard await photosAccess() else {
            showToast("Allow Photos access in Settings to save photos.")
            return
        }
        let album = await ensureAlbum()
        let created = Box()
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = filename
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: data, options: options)
                if let placeholder = request.placeholderForCreatedAsset {
                    created.value = placeholder.localIdentifier
                    if let album, let change = PHAssetCollectionChangeRequest(for: album) {
                        change.addAssets([placeholder] as NSArray)
                    }
                }
            }
            if let identifier = created.value { savedAssets[filename] = identifier }
            showToast(savedOnce ? "Saved" : "Saved to the GeoZipTag album")
            savedOnce = true
        } catch {
            showToast("Could not save the photo.")
        }
    }

    private func photosAccess() async -> Bool {
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined { status = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
        return status == .authorized || status == .limited
    }

    private func findAlbum() -> PHAssetCollection? {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "title = %@", Self.albumName)
        return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options).firstObject
    }

    private func ensureAlbum() async -> PHAssetCollection? {
        if let album = findAlbum() { return album }
        let created = Box()
        do {
            try await PHPhotoLibrary.shared().performChanges {
                created.value = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: Self.albumName)
                    .placeholderForCreatedAssetCollection.localIdentifier
            }
        } catch { return nil }
        guard let identifier = created.value else { return nil }
        return PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [identifier], options: nil).firstObject
    }

    // MARK: Deleting

    private func enqueueDelete(filename: String) {
        let previous = lastSave
        lastSave = Task { [weak self] in
            await previous.value
            await self?.delete(filename: filename)
        }
    }

    /// Removes the photo and its "-original" twin from Photos. iOS asks the user to confirm the deletion itself.
    private func delete(filename: String) async {
        let names = [filename, filename.replacingOccurrences(of: ".jpg", with: "-original.jpg")]
        let identifiers = names.compactMap { savedAssets.removeValue(forKey: $0) }
        var ok = true
        if !identifiers.isEmpty {
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
            if assets.count > 0 {
                do {
                    try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.deleteAssets(assets) }
                } catch { ok = false }
            }
        }
        callPage("window.onPhotoDeleted && window.onPhotoDeleted(\(Self.js(filename)), \(ok))")
    }

    // MARK: Sharing and printing

    private func share(filename: String, data: Data) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do { try data.write(to: url, options: .atomic) } catch {
            showToast("Could not share the photo.")
            return
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url) }
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY, width: 1, height: 1)
        present(sheet, animated: true)
    }

    private func printReport(_ html: String) {
        let printer = ReportPrinter(html: html, presenter: self) { [weak self] in self?.printer = nil }
        self.printer = printer
        printer.start()
    }

    // MARK: Address lookup (Apple's geocoder, like the Android phone geocoder)

    private func lookUp(id: String, lat: Double, lon: Double) {
        let region = Locale.current.regionCode ?? "IN"
        geocoder.cancelGeocode()
        geocoder.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lon),
                                        preferredLocale: Locale(identifier: "en_\(region)")) { [weak self] marks, _ in
            guard let self else { return }
            var payload = "null"
            if let mark = marks?.first {
                var json: [String: Any] = [:]
                let fields: [(String, String?)] = [
                    ("featureName", mark.name), ("thoroughfare", mark.thoroughfare), ("subThoroughfare", mark.subThoroughfare),
                    ("subLocality", mark.subLocality), ("locality", mark.locality),
                    ("subAdminArea", mark.subAdministrativeArea), ("adminArea", mark.administrativeArea),
                    ("postalCode", mark.postalCode), ("countryName", mark.country), ("countryCode", mark.isoCountryCode),
                ]
                for (key, value) in fields { if let value, !value.isEmpty { json[key] = value } }
                json["addressLine"] = [mark.name, mark.thoroughfare, mark.subLocality, mark.locality, mark.administrativeArea, mark.postalCode, mark.country]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
                if let data = try? JSONSerialization.data(withJSONObject: json), let text = String(data: data, encoding: .utf8) { payload = text }
            }
            self.callPage("window.onPhoneAddress && window.onPhoneAddress(\(Self.js(id)), \(payload))")
        }
    }

    // MARK: A short message at the bottom, like the Android toast

    private func showToast(_ text: String) {
        DispatchQueue.main.async {
            self.toast?.removeFromSuperview()
            let label = PaddedLabel()
            label.text = text
            label.font = .systemFont(ofSize: 14, weight: .medium)
            label.textColor = .white
            label.backgroundColor = UIColor(white: 0.1, alpha: 0.92)
            label.layer.cornerRadius = 18
            label.layer.masksToBounds = true
            label.textAlignment = .center
            label.numberOfLines = 2
            label.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: self.view.centerXAnchor),
                label.bottomAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.bottomAnchor, constant: -120),
                label.widthAnchor.constraint(lessThanOrEqualTo: self.view.widthAnchor, constant: -48),
            ])
            self.toast = label
            UIView.animate(withDuration: 0.25, delay: 1.8, options: [], animations: { label.alpha = 0 }) { _ in
                label.removeFromSuperview()
                if self.toast === label { self.toast = nil }
            }
        }
    }
}

/// Carries a value out of a Photos change block.
private final class Box: @unchecked Sendable { var value: String? }

/// The script message handler keeps a strong reference to its target; this avoids a retain cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

private final class PaddedLabel: UILabel {
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16))) }
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 32, height: size.height + 16)
    }
}

/// Loads the report in a hidden web view, then opens iOS's print sheet (which can also save a PDF).
private final class ReportPrinter: NSObject, WKNavigationDelegate {
    private let html: String
    private weak var presenter: UIViewController?
    private let finished: () -> Void
    private let view: WKWebView

    init(html: String, presenter: UIViewController, finished: @escaping () -> Void) {
        self.html = html
        self.presenter = presenter
        self.finished = finished
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        view = WKWebView(frame: CGRect(x: 0, y: 0, width: 612, height: 792), configuration: configuration)
        super.init()
        view.navigationDelegate = self
    }

    func start() { view.loadHTMLString(html, baseURL: nil) }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = "GeoZipTag report"
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        controller.present(animated: true) { [finished] _, _, _ in finished() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finished() }
}
