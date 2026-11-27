import AVFoundation
import UIKit

/// The launch video (iPhone). It sits on top of the page from the app's first screen and loops seamlessly
/// (AVPlayerLooper, retained for as long as the view lives) until the page reports that startup is complete.
/// It only plays; WHEN to remove it is decided by the page's readiness gate (camera, fresh location, address,
/// map, resources and stamping pipeline), never here and never by the video ending.
///
/// Its first frame is the same picture as the static launch screen (LaunchScreen.storyboard shows the same
/// poster, aspect-fit on the same navy), so nothing jumps when the video takes over. The one time rule: the
/// splash is on screen at least 3 s (measured from when it appears), even if the app is ready sooner. With Reduce
/// Motion on, only the poster is shown. The pin in the video is decoration, never the user's location.
final class LaunchSplashView: UIView {
    /// The flat colour around the video (the same as the video's own background).
    static let navy = UIColor(red: 2 / 255, green: 23 / 255, blue: 57 / 255, alpha: 1)
    /// The splash stays up at least this long.
    static let minimumDuration: TimeInterval = 3

    private let poster = UIImageView(image: UIImage(named: "LaunchPoster"))
    private let playerLayer = AVPlayerLayer()
    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?          // keeps the loop going; must stay alive with the player
    private var readyObservation: NSKeyValueObservation?
    private var observers: [NSObjectProtocol] = []
    private let shownAt = CACurrentMediaTime()
    private var dismissing = false

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
            let queuePlayer = AVQueuePlayer()
            queuePlayer.isMuted = true                      // the clip has no sound track either
            queuePlayer.automaticallyWaitsToMinimizeStalling = false
            looper = AVPlayerLooper(player: queuePlayer, templateItem: AVPlayerItem(url: url))
            playerLayer.player = queuePlayer
            playerLayer.videoGravity = .resizeAspect
            playerLayer.opacity = 0                         // the poster shows until the first video frame is ready
            layer.addSublayer(playerLayer)
            readyObservation = playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
                guard layer.isReadyForDisplay else { return }
                DispatchQueue.main.async { self?.playerLayer.opacity = 1 }
            }
            player = queuePlayer
            queuePlayer.play()
        }

        // Pause while the app is inactive (backgrounded, or a permission dialog is up) and resume smoothly.
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.player?.pause()
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.player?.play()
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

    /// Fades the video out and removes it, after the 3 s minimum unless `immediately` (used when a recovery
    /// panel has to be seen). Safe to call more than once.
    func dismiss(immediately: Bool = false) {
        guard superview != nil, !dismissing else { return }
        dismissing = true
        let wait = immediately ? 0 : max(0, LaunchSplashView.minimumDuration - (CACurrentMediaTime() - shownAt))
        UIView.animate(withDuration: 0.3, delay: wait, options: [.curveEaseOut], animations: {
            self.alpha = 0
        }, completion: { _ in
            self.player?.pause()
            self.readyObservation?.invalidate()
            self.readyObservation = nil
            self.observers.forEach { NotificationCenter.default.removeObserver($0) }
            self.observers.removeAll()
            self.looper?.disableLooping()
            self.looper = nil
            self.playerLayer.player = nil
            self.player = nil
            self.removeFromSuperview()
        })
    }
}
