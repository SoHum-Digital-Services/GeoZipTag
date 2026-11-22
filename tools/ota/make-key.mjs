#!/usr/bin/env node
// One-time setup: creates the key pair that signs app updates.
//   private key  -> the file you name (keep it secret: add it to GitHub as the OTA_PRIVATE_KEY secret)
//   public key   -> android/app/src/main/assets/ota-public-key.b64 (bundled in the app)
// Usage: node tools/ota/make-key.mjs ota-private-key.pem
import crypto from 'node:crypto'
import fs from 'node:fs'

const target = process.argv[2]
if (!target) { console.error('Usage: node tools/ota/make-key.mjs <private-key-file>'); process.exit(1) }
if (fs.existsSync(target)) { console.error(`${target} already exists; not overwriting it.`); process.exit(1) }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
fs.writeFileSync('android/app/src/main/assets/ota-public-key.b64', publicKey.export({ type: 'spki', format: 'der' }).toString('base64') + '\n')
console.log(`Private key: ${target} (keep it secret)\nPublic key:  android/app/src/main/assets/ota-public-key.b64`)
