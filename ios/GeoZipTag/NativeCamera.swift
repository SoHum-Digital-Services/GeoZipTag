import AVFoundation
import UIKit

/// The iPhone's own photo camera (the one the Camera app uses), so photos get Apple's full processing:
/// Smart HDR, Deep Fusion and low-light fusion, at full resolution. The live preview is a native layer
/// behind the transparent page; the page drives the camera through WebViewController.
final class NativeCamera: NSObject, AVCapturePhotoCaptureDelegate {
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    let previewView = PreviewView()
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "geoziptag.camera")
    private var input: AVCaptureDeviceInput?
    private var wideFactor: CGFloat = 1          // zoom factor of the main (1×) lens on multi-lens cameras
    private var pending: [Int64: (Data?) -> Void] = [:]
    private var lightTimer: DispatchSourceTimer?
    private var brightened = false

    override init() {
        super.init()
        previewView.previewLayer.session = session
        previewView.previewLayer.videoGravity = .resizeAspectFill
        previewView.backgroundColor = .black
    }

    // MARK: Starting and stopping

    func start(facing: String, completion: @escaping ([String: Any]) -> Void) {
        let finish: ([String: Any]) -> Void = { result in DispatchQueue.main.async { completion(result) } }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            queue.async { self.configure(facing: facing, finish: finish) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { self.queue.async { self.configure(facing: facing, finish: finish) } }
                else { finish(["ok": false, "error": "denied"]) }
            }
        default:
            finish(["ok": false, "error": "denied"])
        }
    }

    func stop() {
        queue.async {
            self.lightTimer?.cancel()
            self.lightTimer = nil
            self.setTorchLocked(false)
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func camera(facing: String) -> AVCaptureDevice? {
        if facing == "user" { return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) }
        // Multi-lens cameras switch lenses by themselves as you zoom (0.5× ultra wide, 1× wide, 2×/3× tele).
        for type in [AVCaptureDevice.DeviceType.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera] {
            if let device = AVCaptureDevice.default(type, for: .video, position: .back) { return device }
        }
        return nil
    }

    private func configure(facing: String, finish: @escaping ([String: Any]) -> Void) {
        guard let device = camera(facing: facing), let newInput = try? AVCaptureDeviceInput(device: device) else {
            finish(["ok": false, "error": "unavailable"])
            return
        }
        setTorchLocked(false)
        session.beginConfiguration()
        session.sessionPreset = .photo
        if let input { session.removeInput(input) }
        guard session.canAddInput(newInput) else {
            if let input, session.canAddInput(input) { session.addInput(input) }
            session.commitConfiguration()
            finish(["ok": false, "error": "unavailable"])
            return
        }
        session.addInput(newInput)
        input = newInput
        if !session.outputs.contains(photoOutput), session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }
        photoOutput.maxPhotoQualityPrioritization = .quality
        session.commitConfiguration()

        wideFactor = 1
        if [.builtInTripleCamera, .builtInDualWideCamera].contains(device.deviceType),
           let first = device.virtualDeviceSwitchOverVideoZoomFactors.first {
            wideFactor = CGFloat(truncating: first)
        }
        if (try? device.lockForConfiguration()) != nil {
            device.videoZoomFactor = max(device.minAvailableVideoZoomFactor, min(wideFactor, device.maxAvailableVideoZoomFactor))
            if device.isLowLightBoostSupported { device.automaticallyEnablesLowLightBoostWhenAvailable = true }
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            // Low light: let each frame collect light for up to 1/10 s instead of keeping a smooth 30 fps
            // (the camera builds the photo from these frames), as the Camera app does in the dark.
            if let range = device.activeFormat.videoSupportedFrameRateRanges.max(by: { $0.maxFrameDuration < $1.maxFrameDuration }) {
                device.activeVideoMaxFrameDuration = CMTimeMinimum(range.maxFrameDuration, CMTime(value: 1, timescale: 10))
            }
            if device.exposureTargetBias != 0 { device.setExposureTargetBias(0, completionHandler: nil) }
            device.unlockForConfiguration()
        }
        brightened = false
        if !session.isRunning { session.startRunning() }
        watchLight()

        let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        let others = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified)
        finish([
            "ok": true, "facing": facing,
            "width": Int(min(size.width, size.height)), "height": Int(max(size.width, size.height)),   // portrait
            "zoom": 1, "zoomMin": Double(device.minAvailableVideoZoomFactor / wideFactor),
            "zoomMax": Double(min(device.maxAvailableVideoZoomFactor, wideFactor * 10) / wideFactor),
            "hasTorch": device.hasTorch && device.isTorchModeSupported(.on),
            "canFocus": device.isFocusPointOfInterestSupported,
            "cameras": max(1, others.devices.count),
        ])
    }

    // MARK: Brightening in the dark

    /// When the camera is at a high ISO (a dark scene), exposes one stop brighter, like the Camera app's
    /// low-light look; back to normal once the light is good. The gap between the two limits avoids flicker.
    private func watchLight() {
        lightTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.adjustForLight() }
        timer.resume()
        lightTimer = timer
    }

    private func adjustForLight() {
        guard session.isRunning, let device = input?.device, device.exposureMode == .continuousAutoExposure else { return }
        let maxISO = device.activeFormat.maxISO, iso = device.iso
        let dark = brightened ? iso > maxISO * 0.2 : iso > maxISO * 0.45
        guard dark != brightened, (try? device.lockForConfiguration()) != nil else { return }
        let bias: Float = dark ? min(1.0, device.maxExposureTargetBias) : 0
        device.setExposureTargetBias(bias, completionHandler: nil)
        device.unlockForConfiguration()
        brightened = dark
    }

    // MARK: Zoom, torch, focus

    /// `zoom` is in the page's units: 1 = the main lens, 0.5 = ultra wide.
    func set(zoom: Double?, torch: Bool?) {
        queue.async {
            guard let device = self.input?.device, (try? device.lockForConfiguration()) != nil else { return }
            if let zoom {
                let factor = CGFloat(zoom) * self.wideFactor
                device.videoZoomFactor = max(device.minAvailableVideoZoomFactor, min(factor, device.maxAvailableVideoZoomFactor))
            }
            device.unlockForConfiguration()
            if let torch { self.setTorchLocked(torch) }
        }
    }

    private func setTorchLocked(_ on: Bool) {
        guard let device = input?.device, device.hasTorch, (try? device.lockForConfiguration()) != nil else { return }
        if device.isTorchModeSupported(on ? .on : .off) { device.torchMode = on ? .on : .off }
        device.unlockForConfiguration()
    }

    /// Focuses and meters at a point on the preview, in the preview's own coordinates (points).
    func focus(at point: CGPoint) {
        let devicePoint = previewView.previewLayer.captureDevicePointConverted(fromLayerPoint: point)
        queue.async {
            guard let device = self.input?.device, (try? device.lockForConfiguration()) != nil else { return }
            if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) {
                device.focusPointOfInterest = devicePoint
                device.focusMode = .autoFocus
            }
            if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposurePointOfInterest = devicePoint
                device.exposureMode = .continuousAutoExposure
            }
            device.unlockForConfiguration()
        }
    }

    func setPreviewOrientation(_ orientation: AVCaptureVideoOrientation) {
        if let connection = previewView.previewLayer.connection, connection.isVideoOrientationSupported {
            connection.videoOrientation = orientation
        }
    }

    // MARK: Taking a photo

    /// Takes a full-quality photo and returns it as an upright JPEG (no EXIF rotation left to apply).
    func capture(orientation: AVCaptureVideoOrientation, completion: @escaping (Data?) -> Void) {
        queue.async {
            guard self.session.isRunning, let connection = self.photoOutput.connection(with: .video) else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            if connection.isVideoOrientationSupported { connection.videoOrientation = orientation }
            let settings = self.photoOutput.availablePhotoCodecTypes.contains(.jpeg)
                ? AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg]) : AVCapturePhotoSettings()
            settings.photoQualityPrioritization = self.photoOutput.maxPhotoQualityPrioritization
            self.pending[settings.uniqueID] = completion
            self.photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let data = error == nil ? photo.fileDataRepresentation().flatMap(Self.upright) : nil
        let id = photo.resolvedSettings.uniqueID
        queue.async {
            let done = self.pending.removeValue(forKey: id)
            DispatchQueue.main.async { done?(data) }
        }
    }

    private static func upright(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        if image.imageOrientation == .up { return image.jpegData(compressionQuality: 0.95) ?? data }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return rendered.jpegData(compressionQuality: 0.95)
    }
}
