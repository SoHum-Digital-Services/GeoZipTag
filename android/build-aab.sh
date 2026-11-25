#!/usr/bin/env bash
# Builds the Google Play upload bundle (.aab), signed with the Play upload key.
#   ANDROID_HOME                                       the Android SDK (or sdk.dir in android/local.properties)
#   GEOSTAMP_UPLOAD_KEYSTORE, GEOSTAMP_UPLOAD_PASSWORD_FILE, GEOSTAMP_UPLOAD_ALIAS (default upload)
#   GEOSTAMP_OUTPUT                                    output folder (default build)
#   ADMOB_APP_ID / ADMOB_BANNER_ID                     real AdMob IDs (default: Google's test IDs)
set -euo pipefail
cd "$(dirname "$0")"
export GEOSTAMP_KEYSTORE="${GEOSTAMP_UPLOAD_KEYSTORE:?Set the upload keystore}"
export GEOSTAMP_SIGNING_PASSWORD_FILE="${GEOSTAMP_UPLOAD_PASSWORD_FILE:?Set the upload password file}"
export GEOSTAMP_KEY_ALIAS="${GEOSTAMP_UPLOAD_ALIAS:-upload}"
out=${GEOSTAMP_OUTPUT:-build}
./gradlew --no-daemon -q bundleRelease
mkdir -p "$out"
cp app/build/outputs/bundle/release/app-release.aab "$out/GeoZipTag.aab"
echo "Built $out/GeoZipTag.aab"
