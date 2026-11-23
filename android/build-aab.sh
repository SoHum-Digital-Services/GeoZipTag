#!/usr/bin/env bash
# Builds the Google Play upload bundle (.aab), signed with the Play upload key.
# Needs the same SDK variables as build-apk.sh plus BUNDLETOOL_JAR, and
# GEOSTAMP_UPLOAD_KEYSTORE / GEOSTAMP_UPLOAD_PASSWORD_FILE / GEOSTAMP_UPLOAD_ALIAS.
set -euo pipefail
cd "$(dirname "$0")"

sdk_jar=${ANDROID_SDK_JAR:-${ANDROID_HOME:-}/platforms/android-36/android.jar}
tools=${ANDROID_BUILD_TOOLS:-${ANDROID_HOME:-}/build-tools/36.0.0}
bundletool=${BUNDLETOOL_JAR:?Set BUNDLETOOL_JAR to bundletool-all.jar}
out=${GEOSTAMP_OUTPUT:-build}
main=app/src/main

mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex" "$work/base/manifest" "$work/base/dex"
mapfile -d '' source < <(find "$main/java" -name '*.java' -print0)
javac -source 8 -target 8 -classpath "$sdk_jar" -d "$work/classes" "${source[@]}"
mapfile -d '' classes < <(find "$work/classes" -name '*.class' -print0)
"$tools/d8" --release --min-api 26 --lib "$sdk_jar" --output "$work/dex" "${classes[@]}"
"$tools/aapt2" compile --dir "$main/res" -o "$work/res.zip"
assets="$work/assets"
cp -R "$main/assets" "$assets"
printf '%s\n%s\n' "$(( $(date -u +%s) / 60 ))" "$(date -u +%y.%m.%d-%H%M)" > "$assets/ota-version.txt"
# Play bundles need resources in protobuf form.
"$tools/aapt2" link --proto-format -I "$sdk_jar" --manifest "$main/AndroidManifest.xml" -A "$assets" \
    -o "$work/proto.apk" "$work/res.zip"
(cd "$work/base" && unzip -q "$work/proto.apk" && mv AndroidManifest.xml manifest/)
cp "$work/dex/classes.dex" "$work/base/dex/"
(cd "$work/base" && zip -q -r "$work/base.zip" .)
rm -f "$out/GeoZipTag.aab"
java -jar "$bundletool" build-bundle --modules="$work/base.zip" --output="$work/unsigned.aab"
jarsigner -keystore "${GEOSTAMP_UPLOAD_KEYSTORE:?Set the upload keystore}" \
    -storepass:file "${GEOSTAMP_UPLOAD_PASSWORD_FILE:?Set the upload password file}" \
    -sigalg SHA256withRSA -digestalg SHA-256 -signedjar "$out/GeoZipTag.aab" \
    "$work/unsigned.aab" "${GEOSTAMP_UPLOAD_ALIAS:-upload}"
jarsigner -verify "$out/GeoZipTag.aab" | tail -1
java -jar "$bundletool" validate --bundle="$out/GeoZipTag.aab" | head -3
