#!/usr/bin/env bash
# Builds a signed APK for direct installs (testing / sharing outside the stores).
#   ANDROID_HOME                    the Android SDK (or sdk.dir in android/local.properties)
#   GEOSTAMP_KEYSTORE               PKCS12 keystore      GEOSTAMP_KEY_ALIAS (default geoziptag-test)
#   GEOSTAMP_SIGNING_PASSWORD_FILE  file with its password
#   GEOSTAMP_OUTPUT                 output folder (default build)
#   ADMOB_APP_ID / ADMOB_BANNER_ID  real AdMob IDs (default: Google's test IDs)
set -euo pipefail
cd "$(dirname "$0")"
: "${GEOSTAMP_KEYSTORE:?Set a signing keystore}" "${GEOSTAMP_SIGNING_PASSWORD_FILE:?Set a password file}"
out=${GEOSTAMP_OUTPUT:-build}
./gradlew --no-daemon -q assembleRelease
mkdir -p "$out"
cp app/build/outputs/apk/release/app-release.apk "$out/GeoZipTag.apk"
echo "Built $out/GeoZipTag.apk"
