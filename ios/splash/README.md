# GeoZiptag launch video and startup gate (iPhone and Android)

## The startup gate (both apps, in `web/camera.js`)

The launch cover (on iPhone also the native launch video on top of it) stays until the app can take AND save a
correctly stamped photo at once. ALL of these must be true:

1. camera permission granted, camera session running, and the first preview frame produced
   (`onNativeCameraFrame`: Android's first completed preview capture, iPhone's first video-output frame)
2. location permission granted and a FRESH fix: determined after the app started, accurate to 100 m or better,
   at most 60 s old; a cached reading alone does not count
3. the address for that fix is resolved
4. the satellite map for that same fix is downloaded and decoded
5. fonts, wordmark and the other stamp resources are loaded
6. the shutter and the stamping pipeline are ready: one real stamp (fresh fix, its address and map, the selected
   style) has been drawn and JPEG-encoded off screen

Camera, location, fonts and lookups start at the same time. Nothing ends the splash on a timer, on the video
ending, on a cached place or on the camera alone. The one time rule: it is shown at least 3 s, counted from when it
appears; being ready is still required on top of that.

If something is refused, fails or stalls (15 s without any progress; time in the background does not count) the
cover shows a recovery panel: **Open Settings** (camera or location refused) and **Try again**. On iPhone the
native video lifts first (`launchProblem`) so the panel can be seen. Try again restarts the camera, the location
and the lookups; coming back from Settings does that automatically. The user is never left on an endless
animation, and nothing is skipped or invented. The routine splash shows no text, coordinates or progress.

## The iPhone launch video

* `LaunchSplashView.swift` only plays: `AVQueuePlayer` + a retained `AVPlayerLooper` (seamless loop), muted,
  paused while the app is inactive (background, permission dialogs) and resumed smoothly. It never decides when to
  end. The page lifts it with `launchReady` (after the 3 s minimum) or `launchProblem` (at once). If the page is
  dead (nothing for 30 s) it is removed so the screen is never frozen; that is not a readiness path.
* `ios/GeoZipTag/GeoZiptagSplash.mp4` - 1080 x 1800, 30 fps, one slow 24 s revolution that loops, H.264, no sound,
  about 3.9 MB.
* `LaunchScreen.storyboard` shows `LaunchPoster` (the clip's first frame) aspect-fit on the same navy (#021739), so the
  video takes over from an identical picture. With Reduce Motion only the poster is shown (the gate still applies).
* The pin in the video is the fixed Cheruvugattu reference: decoration only, never used as the user's location.
* The animation (globe, satellite, "Hey there! I'm right here.", wordmark, arc, tagline) comes from the supplied
  24 s, 1080 x 1920, 60 fps master `GeoZiptag-splash-loop.mp4` (not kept in the repo, 8 MB).
* Licences of the globe texture (NASA Blue Marble) and the rendering library (Three.js): `licenses/`.

Android keeps its static launch cover (icon and "by SoHum") with the same gate and recovery panel.

## Rebuilding the clip from the master

```
ffmpeg -i GeoZiptag-splash-loop.mp4 \
  -vf "fps=30,crop=1080:1800:0:0,drawbox=x=460:y=1740:w=160:h=60:color=0x021739:t=fill,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -profile:v high -level 4.1 -pix_fmt yuv420p -tag:v avc1 \
  -movflags +faststart -an GeoZiptagSplash.mp4
ffmpeg -i GeoZiptagSplash.mp4 -frames:v 1 poster.png      # then resize to 1080x1800 / 720x1200 / 360x600
```

The crop removes a lighter strip baked into the bottom 6 % of the master, and the box paints out its three loading
dots (the background there is a flat colour). Keeping every second frame of the 60 fps master gives true 30 fps
motion with no repeated frames, and the loop point stays seamless.
