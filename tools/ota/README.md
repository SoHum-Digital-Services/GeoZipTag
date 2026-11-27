# Wireless app updates

**Two channels.** Pushes to `main` publish the live update; pushes to any other branch publish a separate preview
(`/preview/ota/`, labelled `-preview`). A phone follows the preview only with Settings → App updates → Preview
versions on (app builds Android 1.23+, iPhone 1.24+). Each channel keeps its own downloads on the phone.

The phone apps are thin shells around the web app in `web/` (bundled into each build). Every push
publishes that web app, signed, to GitHub Pages. The app checks for it in the background and uses it
from the next launch, so UI, stamp, report and logic changes arrive without installing an APK.

An APK is still needed when something **native** changes: Java code, `AndroidManifest.xml`,
permissions, the launcher icon, or the list of served file names (`OtaUpdater.WEB_PATH`).

## One-time setup

1. **Signing key.** On a computer with Node 18+:
   `node tools/ota/make-key.mjs ota-private-key.pem`
   This writes the private key to `ota-private-key.pem` and the public key to
   `android/app/src/main/assets/ota-public-key.b64` (commit that file, build the APK with it).
   Keep `ota-private-key.pem` secret and backed up. Never commit it (`*.pem` is git-ignored).
2. **GitHub secret.** Repository → Settings → Secrets and variables → Actions → New repository secret:
   name `OTA_PRIVATE_KEY`, value = the full contents of `ota-private-key.pem`.
3. **Run the workflow** once (Actions → "Publish web app and app updates" → Run workflow). It creates the
   `gh-pages` branch.
4. **Turn on Pages.** Settings → Pages → Source: "Deploy from a branch" → branch `gh-pages`, folder `/ (root)`.
   The site is then at `https://<owner>.github.io/<repo>/` (the browser app) and `.../ota/` (the updates).
5. **Build and install an APK** that contains the public key. From then on updates are wireless.

## How an update works

* `publish.mjs` copies the web files, writes `manifest.txt` (version, label, minimum app version, and the
  SHA-256 of every file) and signs it with ECDSA P-256 (`manifest.txt.sig`).
* The app downloads the manifest, verifies the signature with the public key bundled in the APK, then
  downloads only the files that changed and checks each against its signed hash.
* A verified update is staged and takes effect on the next page load (next launch, or "Update ready" →
  tap to restart). A version that never reports a successful start (`AndroidHost.otaConfirm()`, called at
  the end of `camera.js`) is rolled back after two tries and never retried.
* Old versions are never accepted (versions only go up), and an update newer than the installed app
  supports (`android/ota-min-apk.txt` vs the app's version code) waits for an APK.

## Rules of thumb

* Bump `android:versionCode` and set `android/ota-min-apk.txt` to it whenever the web code starts to
  depend on new native code (a new `AndroidHost` method, a new permission, ...). Older apps then keep
  their current web version until the new APK is installed.
* Lost private key: install an APK with a new public key and set a new secret. Phones with the old key
  need that APK once.
* Tests: `bash tools/ota/test/run.sh` (needs Node and a JDK).
