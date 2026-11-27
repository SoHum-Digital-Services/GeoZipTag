import AVFoundation
import UIKit

/// The launch video (iPhone). It sits on top of the page from the app's first screen, plays once and then holds
/// its last frame until the page reports that the camera, location, address and map are ready; then it fades out.
///
/// Its first frame is the same picture as the static launch screen (LaunchScreen.storyboard shows the same
/// poster, aspect-fit on the same navy), so nothing jumps when the video takes over. There is no minimum time:
/// if the app is ready at once, the video is removed at once. With Reduce Motion on, only the poster is shown.
final class LaunchSplashView: UIView {
    /// The flat colour around the video (the same as the video's own background).
    static let navy = UIColor(red: 2 / 255, green: 23 / 255, blue: 57 / 255, alpha: 1)

    private let poster = UIImageView(image: UIImage(named: "LaunchPoster"))
    private let playerLayer = AVPlayerLayer()
    private var player: AVPlayer?
    private var readyObservation: NSKeyValueObservation?
    private var observers: [NSObjectProtocol] = []
    private var finished = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = LaunchSplashView.navy
        isAccessibilityElement = true
        accessibilityLabel = "GeoZiptag"

        poster.contentMode = .scaleAspectFit
        poster.frame = bounds
        poster.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(poster)

        if !UIAccessibility.isReduceMotionEnabled,
           let url = Bundle.main.url(forResource: "GeoZiptagSplash", withExtension: "mp4") {
            let item = AVPlayerItem(url: url)
            let player = AVPlayer(playerItem: item)
            player.isMuted = true                            // the clip has no sound track either
            player.automaticallyWaitsToMinimizeStalling = false
            playerLayer.player = player
            playerLayer.videoGravity = .resizeAspect
            playerLayer.opacity = 0                          // the poster shows until the first video frame is ready
            layer.addSublayer(playerLayer)
            readyObservation = playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
                guard layer.isReadyForDisplay else { return }
                DispatchQueue.main.async { self?.playerLayer.opacity = 1 }
            }
            observers.append(NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
            ) { [weak self] _ in self?.finished = true })   // plays once; the last frame stays on screen
            self.player = player
            player.play()
        }

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.player?.pause()
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, !self.finished else { return }
            self.player?.play()
        })
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = bounds
        CATransaction.commit()
    }

    /// Fades the video out and removes it. Safe to call more than once.
    func dismiss() {
        guard superview != nil else { return }
        UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut], animations: {
            self.alpha = 0
        }, completion: { _ in
            self.player?.pause()
            self.readyObservation?.invalidate()
            self.readyObservation = nil
            self.observers.forEach { NotificationCenter.default.removeObserver($0) }
            self.observers.removeAll()
            self.playerLayer.player = nil
            self.player = nil
            self.removeFromSuperview()
        })
    }
}
