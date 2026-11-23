# GeoZipTag

GPS photo camera with a satellite map, location details, coordinates, date and time embedded into captured photos.

Includes a browser app and an Android WebView host with native photo saving, sharing, system-camera integration and report printing.

## Project structure

- `web/` contains the standalone HTML, CSS, JavaScript, fonts, branding and QR generator.
- `android/` contains the Android application, build script and bundled web interface.

The Android interface includes a native JavaScript bridge for saving, sharing and printing.

## Run the web app

From the repository root, run

```sh
python3 -m http.server 8080 --directory web
```

Open http://localhost:8080.

Camera and location access require permission and a secure browser context. Use HTTPS when opening the app on a phone over the network. Browsers generally treat localhost as a secure context for local development.

For a satellite stamp, allow location access and wait for GPS ready. The camera screen includes an Add location & map action that can switch from a saved date-and-time template.

## Build Android

Version 1.12, version code 13. Supports Android 8.0 and later, with minimum API 26 and target SDK 36.

Install Android SDK platform 36, build-tools 36.0.0, JDK 17 or newer, Bash and zip. Set ANDROID_HOME, GEOSTAMP_KEYSTORE and GEOSTAMP_SIGNING_PASSWORD_FILE to your local SDK and signing configuration, then run

```sh
cd android
bash build-apk.sh
```

The output is `android/build/GeoZipTag.apk`. The script also accepts explicit ANDROID_SDK_JAR and ANDROID_BUILD_TOOLS paths. ECJ_JAR can select the Eclipse Java compiler.

An update to an existing Android installation requires the same signing certificate used for that installation.

## Services and data

Reverse geocoding uses Photon. Satellite tiles use Esri Wayback World Imagery, release identifier 32246. QR location links open Google Maps.

Location lookup and satellite imagery require an internet connection. Coordinates are sent to the location and imagery services when those features are used. Photo processing runs on the device. Preferences use browser localStorage.

Asset and bundled-library licenses are included alongside their files.

## Verification status

The latest update passed automated camera-entry, location-mode, photo-stamp, QR, report and Android bridge checks. A live imagery test rendered a complete satellite square into the stamp at the saved test coordinates. The Android APK built successfully and its signing certificate was verified.

Physical-device validation remains pending. The managed browser preview encountered a relay timeout during the latest update.
