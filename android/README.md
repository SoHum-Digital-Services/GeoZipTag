# GeoZiptag for Android

An Android host for the bundled GeoZiptag interface. The build opens its live viewfinder on launch. The phone’s built-in camera is also available in Camera settings, and its photos are processed locally on return. The build includes satellite and QR stamps, manual location, original photo export, sharing, and photo reports. Minimum Android version is 8.0 (API 26). Android System WebView should be current for the device.

## Where the screens come from

The interface is the repository's `web/` folder. The Gradle task `bundleWebApp` copies it into the APK as
`assets/web` on every build, so there is nothing to copy by hand. Only the public update key
(`app/src/main/assets/ota-public-key.b64`) lives in the Android assets.

## Build

Install Android SDK platform 36, build-tools 36.0.0 and JDK 17 or newer. Set `ANDROID_HOME` (or `sdk.dir` in `local.properties`), `GEOSTAMP_KEYSTORE`, and `GEOSTAMP_SIGNING_PASSWORD_FILE` before running `./build-apk.sh`; it builds with the Gradle wrapper (`./gradlew`). The signed APK is written to `build/GeoZipTag.apk`. `./build-aab.sh` makes the Google Play bundle with the upload key. Set `ADMOB_APP_ID` and `ADMOB_BANNER_ID` for real ads; without them the banner shows Google's test ads.

The camera and JPEG/PDF preparation run locally. Reverse geocoding and satellite imagery require network access. Android 10 and later save pictures to Pictures/GeoZipTag. Android 8 and 9 use Android's document save picker.
