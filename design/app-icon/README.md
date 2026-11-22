# GeoZipTag app icon

The icon is a cream shutter-ring lens with the approved India-facing globe as its
glass and a coral location pin, on a teal gradient. It uses only the app's own
colours: teal `#1A8797` → `#0A3A45`, cream `#FFF6E6`, coral `#FF8466` → `#E5533D`.

It is drawn on Android's 108-unit adaptive-icon grid (visible area 18–90, safe
circle radius 33), so every version comes from the same artwork.

| File | Used for |
|---|---|
| `geoziptag-app-icon-full.svg` | Square icon (visible 72 units): iPhone home screen, web icons, app header, stamp tab, legacy Android |
| `geoziptag-app-icon-fg.svg` | Android adaptive foreground layer (transparent, full 108 grid) |
| `geoziptag-app-icon-mono.svg` | Android 13+ themed icon (single colour) |
| `globe-artwork-approved.svg` | The original approved globe artwork the icon is built from |

The Android background layer is `android/app/src/main/res/drawable/geoziptag_launcher_background.xml`
(same gradient). PNG exports live in the app's `res/mipmap-*` and `assets/` folders.
