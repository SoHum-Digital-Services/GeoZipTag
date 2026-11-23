# Publishing GeoZipTag on Google Play

Everything to copy into Play Console. The app is published by **SoHum Digital Services**.

| | |
|---|---|
| Package name (permanent) | `cc.sohum.geoziptag` |
| Upload file | `GeoZipTag.aab`, built with `android/build-aab.sh` |
| Version | 1.15 (version code 16) |
| Privacy policy URL | https://sohum-digital-services.github.io/GeoZipTag/privacy.html |
| Website | https://geoziptag.sohum.cc |
| Icon (512 × 512) | `play-icon-512.png` |
| Feature graphic (1024 × 500) | `feature-graphic.png` |

## 1. Create the developer account (one time)

1. Go to https://play.google.com/console/signup and sign in with the Google account SoHum will own the app with.
2. Choose the account type:
   - **Organization** (recommended for SoHum Digital Services): needs a free D-U-N-S number for the company
     (request it at https://www.dnb.com/duns/get-a-duns.html; it takes a few days). Organization accounts
     can publish to everyone straight away.
   - **Personal**: faster to open, but Google requires a **closed test with at least 12 testers for
     14 days in a row** before the app can go to production.
3. Developer name: **SoHum Digital Services**. Website: **https://geoziptag.sohum.cc**.
4. Pay the one-time US$25 fee and finish identity verification (ID card, and for Organization the D-U-N-S
   details). Google also asks you to verify a contact phone and email, and to sign in to the Play Console
   app on an Android phone.

## 2. Create the app

Play Console → **Create app**:

- App name: **GeoZipTag by SoHum**
- Default language: **English (India) – en-IN**
- App or game: **App** · Free or paid: **Free**
- Tick the declarations and **Create app**.

## 3. Upload the bundle

Testing → **Internal testing** (or **Closed testing** for a Personal account) → Create new release:

- Play App Signing: keep **"Use Google-generated key"** (Google keeps the real signing key; ours is only the
  *upload key*, and Google can reset it if it is ever lost).
- Upload `GeoZipTag.aab`. Release name: `1.15`. Release notes:
  `First release: GPS map stamps, photo attendance with employee IDs, video, and a shared team register.`
- Add testers (email list), save, **Review release → Start rollout**.

When testing is done: **Production → Create new release → Add from library** (pick the same bundle) and roll out.

## 4. Store listing

Grow → Store presence → **Main store listing**

**App name** (30 max)
```
GeoZipTag by SoHum
```

**Short description** (80 max)
```
GPS map stamp camera with photo attendance log in and log out for teams
```

**Full description**
```
GeoZipTag stamps every photo with where and when it was taken: the place, full address, GPS coordinates, a satellite map, date and time. Made for field work, site visits, inspections and staff attendance.

GPS MAP STAMP
• Place name, address, latitude and longitude, and a satellite map on every photo
• Indian date format, your time zone, and an optional note
• Three stamp styles: Satellite (general), Attendance, and QR code
• Photo sizes 16:9, 4:3 and 1:1

PHOTO ATTENDANCE
• Log in and log out with a photo: the Attendance stamp shows the employee ID, name, LOG IN or LOG OUT, time and place
• Your own employee ID is stamped by default; pick any colleague in one touch from a rolling ID wheel
• Add employee IDs by typing, or import them in bulk from a text, CSV or PDF file
• Attendance register on the phone, exported as a CSV file for Excel or Google Sheets

SHARED TEAM REGISTER (optional)
• Create a team and share its code; every phone that joins sends its log in and log out entries to one register
• The manager opens the register with a PIN to see who logged in, when, where, with a small proof photo

CAMERA
• Native camera with good low-light quality
• Zoom lenses, flash Auto/On/Off, brightness, focus, timer, grid and level
• Photo and video modes; videos carry the stamp too
• Volume button shutter

PRIVATE BY DESIGN
• No account, no ads, no tracking
• Photos stay on your phone until you share them
• Location is used only while the app is open

GeoZipTag is made by SoHum Digital Services.
```

**Graphics**
- App icon: `play-icon-512.png`
- Feature graphic: `feature-graphic.png`
- Phone screenshots: 4 to 8 screenshots taken on the phone (portrait). Good ones:
  1. Live camera with the Attendance stamp
  2. A finished photo with the Satellite stamp
  3. The employee ID wheel (Log in / Log out)
  4. The attendance register
  5. Settings
  6. A video with the stamp

**Category**: Photography · **Tags**: Camera, Photography, Productivity
**Contact details**: email (required; shown publicly), website https://geoziptag.sohum.cc

## 5. App content (Policy → App content)

| Section | Answer |
|---|---|
| Privacy policy | https://sohum-digital-services.github.io/GeoZipTag/privacy.html |
| Ads | No, the app does not contain ads |
| App access | All functionality is available without special access |
| Content rating | Questionnaire category **Utility, Productivity, Communication or other**; answer **No** to everything. Expected rating: Everyone / 3+ |
| Target audience | **18 and over** only |
| News app | No |
| Government app | No |
| Financial features | None |
| Health | None |
| Data safety | See below |

### Data safety

**Does your app collect or share any of the required user data types?** Yes
**Is all of the user data encrypted in transit?** Yes
**Do you provide a way for users to request that their data is deleted?** Yes (privacy policy, "Deleting your data")

Data types to declare as **Collected** (not shared). For each one: *Processed ephemerally: No*,
*Collection is optional* (users choose to join a team), *Purpose: App functionality*.
Only the shared team register sends these to our server; everything else stays on the phone and is not
"collected" in Google's sense.

| Category | Data type | Why |
|---|---|---|
| Location | Precise location | Coordinates of attendance entries in the team register |
| Personal info | Name | Employee name in the team register |
| Personal info | User IDs | Employee ID in the team register |
| Photos and videos | Photos | Small proof photo in the team register |

Location coordinates are also sent to address and map services (Photon, Nominatim, Esri) to look up the
address. Google treats this as data sent to a service provider on your behalf, which is not "sharing", so
nothing goes under **Shared**.

## 6. Building a new version

1. Raise `android:versionCode` (and `versionName`) in `android/app/src/main/AndroidManifest.xml`.
   Play rejects a bundle whose version code it has already seen.
2. Build:
   ```
   export ANDROID_SDK_JAR=.../platforms/android-36/android.jar
   export ANDROID_BUILD_TOOLS=.../build-tools/36.0.0
   export BUNDLETOOL_JAR=.../bundletool-all-1.17.2.jar
   export GEOSTAMP_UPLOAD_KEYSTORE=.../sohum-upload-key.p12
   export GEOSTAMP_UPLOAD_PASSWORD_FILE=.../upload-password.txt
   bash android/build-aab.sh
   ```
3. Upload the new `GeoZipTag.aab` as a new release.

Changes to the app's screens (camera.js, style.css, index.html) still reach phones through the built-in
signed web update, also for the Play Store version. Google allows this because it is JavaScript running in a
WebView, not new native code.

**Keep the upload key (`sohum-upload-key.p12`) and its password safe and out of git.** If it is lost, ask
Google for an upload key reset in Play Console → Setup → App signing.
