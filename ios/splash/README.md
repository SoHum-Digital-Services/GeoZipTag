# GeoZiptag launch video (iPhone)

On the iPhone the app opens with a short video instead of a still screen. It is native (`LaunchSplashView.swift`)
and sits on top of the page until the page reports that the camera, location, address and map are ready
(`launchReady` message, sent from `releaseLaunch()` in `web/camera.js`). It plays once, holds its last frame and
fades out; there is no minimum time, and a 12 s safety timer removes it if the page never answers.
Reduce Motion shows only the still poster.

* `ios/GeoZipTag/GeoZiptagSplash.mp4` – 1080 x 1800, 30 fps, 5 s, H.264, no sound, about 0.9 MB.
* `ios/GeoZipTag/Assets.xcassets/LaunchPoster.imageset` – the clip's first frame. `LaunchScreen.storyboard`
  shows it aspect-fit on the same navy (#021739), so the video takes over from an identical picture.
* The animation (globe, satellite, "Hey there! I'm right here.", wordmark) comes from the supplied
  24 s, 1080 x 1920, 60 fps master `GeoZiptag-splash-loop.mp4` (not kept in the repo, 8 MB).
  The pin is the fixed Cheruvugattu reference, not the user's measured location.
* Licences of the globe texture (NASA Blue Marble) and the rendering library (Three.js): `licenses/`.

## Rebuilding the clip from the master

```
ffmpeg -ss 2.5 -t 5 -i GeoZiptag-splash-loop.mp4 \
  -vf "fps=30,crop=1080:1800:0:0,drawbox=x=460:y=1740:w=160:h=60:color=0x021739:t=fill,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -profile:v high -level 4.1 -pix_fmt yuv420p -tag:v avc1 \
  -movflags +faststart -an GeoZiptagSplash.mp4
ffmpeg -i GeoZiptagSplash.mp4 -frames:v 1 poster.png      # then resize to 1080x1800 / 720x1200 / 360x600
```

The window starts at 2.5 s so the pin is visible from the first frame and centres within about 2.5 s (the first
1-3 seconds are what people usually see). The crop removes a lighter strip baked into the bottom 6 % of the master,
and the box paints out its three loading dots (the background there is a flat colour).
