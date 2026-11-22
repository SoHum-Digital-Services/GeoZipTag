#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

sdk_jar=${ANDROID_SDK_JAR:-${ANDROID_HOME:-}/platforms/android-36/android.jar}
tools=${ANDROID_BUILD_TOOLS:-${ANDROID_HOME:-}/build-tools/36.0.0}
out=${GEOSTAMP_OUTPUT:-build}
main=app/src/main

mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex"
mapfile -d '' source < <(find "$main/java" -name '*.java' -print0)
if [[ -n ${ECJ_JAR:-} ]]; then
    java -jar "$ECJ_JAR" -source 8 -target 8 -classpath "$sdk_jar" -d "$work/classes" "${source[@]}"
else
    javac -source 8 -target 8 -classpath "$sdk_jar" -d "$work/classes" "${source[@]}"
fi
mapfile -d '' classes < <(find "$work/classes" -name '*.class' -print0)
"$tools/d8" --min-api 26 --lib "$sdk_jar" --output "$work/dex" "${classes[@]}"
"$tools/aapt2" compile --dir "$main/res" -o "$work/res.zip"
"$tools/aapt2" link -I "$sdk_jar" --manifest "$main/AndroidManifest.xml" -A "$main/assets" \
    -o "$work/resources.apk" "$work/res.zip"
cp "$work/resources.apk" "$work/unsigned.apk"
(cd "$work/dex" && zip -q "$work/unsigned.apk" classes.dex)
"$tools/zipalign" -p -f 4 "$work/unsigned.apk" "$work/aligned.apk"
"$tools/apksigner" sign --ks "${GEOSTAMP_KEYSTORE:?Set a signing keystore}" \
    --ks-pass "file:${GEOSTAMP_SIGNING_PASSWORD_FILE:?Set a password file}" \
    --v4-signing-enabled false --out "$out/GeoZipTag.apk" "$work/aligned.apk"
"$tools/apksigner" verify --verbose "$out/GeoZipTag.apk"
