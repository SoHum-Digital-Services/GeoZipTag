#!/usr/bin/env bash
# Tests the over-the-air update logic on a plain JVM (no Android needed).
# Usage: bash tools/ota/test/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A throwaway signing key, so the real one is never needed to run the tests.
node -e "
const c = require('node:crypto'), fs = require('node:fs');
const { privateKey, publicKey } = c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
fs.writeFileSync('$work/private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync('$work/public.b64', publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));"

OTA_PRIVATE_KEY=$(cat "$work/private.pem") node tools/ota/publish.mjs --out "$work/site" --min-apk 5

mkdir -p "$work/classes"
javac --release 8 -d "$work/classes" android/app/src/main/java/com/geostampcam/mobile/OtaUpdater.java
javac -cp "$work/classes" -d "$work/classes" tools/ota/test/OtaUpdaterTest.java
java -cp "$work/classes" com.geostampcam.mobile.OtaUpdaterTest \
    "$work/site" "$work/private.pem" "$work/public.b64" web

# The preview channel labels its update, the live one does not (Settings shows which a phone follows).
OTA_PRIVATE_KEY=$(cat "$work/private.pem") node tools/ota/publish.mjs --out "$work/preview" --channel preview --min-apk 5 >/dev/null
grep -q '^label .*-preview$' "$work/preview/ota/manifest.txt" && ! grep -q '^label .*-preview$' "$work/site/ota/manifest.txt" \
    && echo "PASS the preview update is labelled -preview, the live one is not" \
    || { echo "FAIL channel labels"; exit 1; }
