#!/usr/bin/env node
// Owner's one-time setup: makes a NEW ES256 (ECDSA P-256) key pair for GeoZipTag entitlements. Not the OTA key.
//   node tools/geoziptag/make-signing-key.mjs <output-dir-outside-the-repo> <key-id>
// Writes two files into the directory (private mode 0600):
//   GEOZIPTAG_SIGNING_KEY.txt   PKCS8 DER, standard base64   -> function secret GEOZIPTAG_SIGNING_KEY (keep a backup outside the repo)
//   GEOZIPTAG_PUBLIC_KEYS.json  sohum.geoziptag.public_keys/1 -> function setting GEOZIPTAG_PUBLIC_KEYS, and later bundled in the app
// Prints only file names and the key id, never a key. Refuses to write inside a git work tree.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [dirArg, keyId] = process.argv.slice(2)
if (!dirArg || !keyId || !/^[A-Za-z0-9_.-]{1,40}$/.test(keyId)) {
  console.error('Usage: node tools/geoziptag/make-signing-key.mjs <output-dir-outside-the-repo> <key-id>')
  process.exit(1)
}
const dir = path.resolve(dirArg)
fs.mkdirSync(dir, { recursive: true })
try {
  execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
  console.error(`${dir} is inside a git work tree. Choose a folder outside any repository.`)
  process.exit(1)
} catch { /* not inside a repo: good */ }
const priv = path.join(dir, 'GEOZIPTAG_SIGNING_KEY.txt')
const pub = path.join(dir, 'GEOZIPTAG_PUBLIC_KEYS.json')
if (fs.existsSync(priv) || fs.existsSync(pub)) { console.error('Key files already exist there; not overwriting.'); process.exit(1) }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') + '\n', { mode: 0o600 })
const keys = { schema: 'sohum.geoziptag.public_keys/1', keys: [{
  key_id: keyId, alg: 'ES256', public_key_b64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  not_before: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), retired_at: null }] }
fs.writeFileSync(pub, JSON.stringify(keys, null, 2) + '\n')
console.log(`Wrote ${priv} (secret, back it up outside the repo) and ${pub} (public). Key id: ${keyId}`)
