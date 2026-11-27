# GeoZiptag app icon

Navy background, a photo globe facing India, a gold 3D map pin with a camera lens, viewfinder corners, a satellite,
the GeoZiptag wordmark (white Geo, gold Ziptag) with its gold arc, and the tagline "Click. Tag. Share.".
The pin uses the same gold as "Ziptag" (light `#FFD828` at the top to amber `#F09600` at the tip).

| File | What it is |
|---|---|
| `geoziptag-icon-1024.png` | The master: full square, no transparency (the App Store icon; iOS and Google Play round the corners themselves) |
| `geoziptag-icon-rounded.png` | The same art with its own rounded corners (1248 px), used as the Android adaptive-icon foreground |

Exports made from these masters:

| Where | Files |
|---|---|
| iPhone | `ios/GeoZipTag/Assets.xcassets/AppIcon.appiconset/` (all sizes) |
| Android | `android/app/src/main/res/mipmap-*/geoziptag_launcher*.png`; adaptive background colour `#061A3B` in `res/values/colors.xml` |
| Google Play | `android/play/play-icon-512.png` |
| Web app | `web/assets/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `app-icon-ios.png` (launch cover) |

The icon was rebuilt from layered artwork (globe, pin, lens, satellite, wordmark as separate layers). The pin and
the viewfinder corners are redrawn as clean shapes; the globe, lens, satellite and wordmark are the original art.

Still on the earlier icon, on purpose: `web/assets/app-icon.png` (the small chip on photo stamps and the app
header). Changing it changes how stamped photos look, so it is a separate decision.
