#!/usr/bin/env bash
# Tests the iOS update logic (macOS only: needs swiftc and CryptoKit). Usage: bash tools/ota/test/ios/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../../.."
work=$(mktemp -d)
trap 'kill $server 2>/dev/null; rm -rf "$work"' EXIT

node -e "
const c = require('node:crypto'), fs = require('node:fs');
for (const name of ['test', 'other']) {
  const { privateKey, publicKey } = c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync('$work/' + name + '.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync('$work/' + name + '.b64', publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}"
OTA_PRIVATE_KEY=$(cat "$work/test.pem") node tools/ota/publish.mjs --out "$work/serve/good" --min-apk 5
cp -R "$work/serve/good" "$work/serve/tampered"
sed -i.bak 's/^min-apk 5$/min-apk 4/' "$work/serve/tampered/ota/manifest.txt"
cp -R "$work/serve/good" "$work/serve/badfile"
printf 'changed' >> "$work/serve/badfile/ota/files/style.css"

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/serve" >/dev/null 2>&1 &
server=$!
sleep 1

mkdir -p "$work/bundle" "$work/roots"
cp -R android/app/src/main/assets/web/. "$work/bundle/"
printf 'old' >> "$work/bundle/camera.js"   # so the update has a changed file to download
swiftc -O -o "$work/ota-test" ios/GeoZipTag/OtaUpdater.swift tools/ota/test/ios/main.swift
"$work/ota-test" "http://127.0.0.1:$port/" "$work/test.b64" "$work/other.b64" "$work/bundle" "$work/roots"
