# GeoZipTag for iOS

A native iPhone app (Swift, WKWebView) around the same web app the Android build uses. It reads the web
files straight from `android/app/src/main/assets/web`, so there is one copy to maintain.

What the app adds over the Safari version: every photo is saved automatically into a **GeoZipTag** album in
Photos, the Delete button removes the photo from Photos too (iOS asks you to confirm), Share opens the iOS
share sheet, addresses also come from Apple's geocoder, and reports print or save as PDF.

## How it works
- `LocalServer.swift` serves the bundled files on `http://127.0.0.1:47653` (loopback only). iOS only allows the
  camera and location on secure origins, and 127.0.0.1 counts as one.
- `WebViewController.swift` injects a `window.AndroidHost` object (the page's existing host interface) and
  implements it natively.
- `project.yml` is an [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec; the `.xcodeproj` is generated.

## Building
The workflow `.github/workflows/ios.yml` builds on a Mac runner on every change, starts the app in the
simulator and checks it serves its files. It produces an **unsigned** `GeoZipTag-unsigned.ipa`, published at
https://github.com/SoHum-Digital-Services/GeoZipTag/releases/download/ios-latest/GeoZipTag-unsigned.ipa On a Mac: `brew install xcodegen && cd ios && xcodegen generate && open GeoZipTag.xcodeproj`.

## Installing on an iPhone
Apple only runs signed apps, so the unsigned .ipa must be signed with an Apple ID:
- **Free Apple ID:** sideload with AltStore or Sideloadly (needs a computer; the app expires after 7 days and
  must be re-signed).
- **Apple Developer Program (99 USD/year):** sign in Xcode or add signing to the workflow, then distribute
  through TestFlight (installs over the air, valid 90 days per build) or the App Store.

## Not verified on a real device
Camera, location, saving to Photos and deleting have only been compiled and smoke-tested in the simulator
(which has no camera). Try them on a phone before relying on them.
