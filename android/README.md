# GeoZipTag for Android

An Android host for the bundled GeoZipTag interface. The build opens its live viewfinder on launch. The phone’s built-in camera is also available in Camera settings, and its photos are processed locally on return. The build includes satellite and QR stamps, manual location, original photo export, sharing, and photo reports. Minimum Android version is 8.0 (API 26). Android System WebView should be current for the device.

## Build

Install Android SDK platform 36, build-tools 36.0.0, JDK 17 or newer, and the `zip` command. Set `ANDROID_HOME`, `GEOSTAMP_KEYSTORE`, and `GEOSTAMP_SIGNING_PASSWORD_FILE` before running `./build-apk.sh`. The signed APK is written to `build/GeoZipTag.apk`. The script also accepts explicit `ANDROID_SDK_JAR` and `ANDROID_BUILD_TOOLS` paths.

The camera and JPEG/PDF preparation run locally. Reverse geocoding and satellite imagery require network access. Android 10 and later save pictures to Pictures/GeoZipTag. Android 8 and 9 use Android's document save picker.
