# GeoZiptag

A GPS photo camera by SoHum Digital Services. Every photo is stamped with the place, address, coordinates,
a satellite map, date and time. It also includes photo attendance with employee IDs, a shared team register,
video, and photo reports.

## Versions

| Platform | Version | Where it lives | Where to bump it |
|---|---|---|---|
| Android | **1.24** (version code 25) | `android/` | `android/app/build.gradle` (`versionName`, `versionCode`) |
| iPhone | **1.25** (build 26) | `ios/` | `ios/project.yml` (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`) |
| Web | dated automatically, e.g. `26.11.27-1650` | `web/` | nothing to bump: each publish is stamped with its date and time |

Package / bundle ID on both phones: `cc.sohum.geoziptag`. The app shows its own version and its web version in
Settings.

## How the repository is organised

```
web/        The app itself (HTML, CSS, JavaScript, fonts, icons). The ONE copy, used by all three versions.
android/    Android app: a native shell (camera, saving, sharing, ads, launch video) around web/.
ios/        iPhone app: the same native shell in Swift around web/.
tools/ota/  Signed wireless updates of web/ for the installed apps, and their tests.
design/     Icon masters (design/app-icon/).
.github/    Builds: the iPhone app (ios.yml) and the web site + wireless update (pages.yml).
```

Both phone apps bundle `web/` when they are built: Android copies it into the APK (Gradle task `bundleWebApp`),
iPhone adds it as a folder (`ios/project.yml`). Edit the screens only in `web/`; never copy files by hand.

How a change in `web/` reaches people:

- **Browser:** published to https://sohum-digital-services.github.io/GeoZipTag/ on every push.
- **Installed apps:** the same files go out as a signed wireless update (see `tools/ota/README.md`); the apps pick
  it up in the background and use it on the next start.
- **New app builds** include the latest `web/` from the start.

### Live and preview

Publishing is split in two (`.github/workflows/pages.yml`), so an experiment never reaches phones by accident:

| Branch pushed | Published as | Who gets it |
|---|---|---|
| `main` | the live site and live update | every installed app, automatically |
| any other branch | `/preview/` (site at https://sohum-digital-services.github.io/GeoZipTag/preview/, update labelled `-preview`) | only phones with **Settings → App updates → Preview versions** switched on |

Each side keeps its own downloads on the phone, so switching never mixes versions. Preview is the way to try a
change on both phones without installing anything; merge to `main` to make it live. (Needs an app build that has
the switch: Android 1.23+, iPhone 1.24+. Older installs ignore previews and keep following live.)

Native changes (anything in `android/` or `ios/`) need a new app build.

## Building

**Web**, locally: `python3 -m http.server 8080 --directory web`, then open http://localhost:8080.
Camera and location need a secure context (localhost, or HTTPS on a phone).

**Android:** see `android/README.md`. In short: Android SDK 36, JDK 17+, a signing key, then
`bash android/build-apk.sh` (test/sideload APK) or `bash android/build-aab.sh` (Google Play bundle).
Google Play publishing steps: `android/play/PLAY-STORE.md`.

**iPhone:** built on GitHub's Mac runners by `.github/workflows/ios.yml` on every change. The unsigned IPA is at
https://github.com/SoHum-Digital-Services/GeoZipTag/releases/download/ios-latest/GeoZipTag-unsigned.ipa
See `ios/README.md` for signing and installing.

## Releasing a new version

1. Bump the version of each phone app you are releasing (table above). Play and the App Store refuse a build
   number they have already seen.
2. If the new `web/` needs new native code, set `android/ota-min-apk.txt` to the new Android version code, so
   older installed apps keep their current screens until they are updated.
3. Update the version table in this file.

## Services and data

Addresses come from the phone's own geocoder (Apple or Google), Photon and Nominatim; satellite imagery from
Esri World Imagery (Wayback release 32246). Coordinates (never photos) are sent to those services. Photos
are processed on the phone. Ads: Google AdMob, one banner in the photo view (test ads until the store listings
exist). Privacy policy: `web/privacy.html`. Licences of bundled libraries, fonts and media are kept next to
their files.
