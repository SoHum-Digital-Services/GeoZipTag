#!/usr/bin/env node
// Builds the GitHub Pages site:
//   <out>/            the browser version of the app (web/), for iPhone and desktop
//   <out>/ota/        the signed over-the-air update for the Android app
//
// Usage: node tools/ota/publish.mjs [--out _site] [--web web] [--site web]
// The update is signed with the private key in OTA_PRIVATE_KEY (PEM, ECDSA P-256). Without it the
// site is still built, but no update is published.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []))
const out = args.out || '_site'
const webDir = args.web || 'web'                               // the app's files (the same web/ folder the apps bundle)
const siteDir = args.site || 'web'                              // what browsers get

// The only files the Android app will serve or accept (keep in sync with OtaUpdater.java).
const allowed = /^(index\.html|style\.css|camera\.js|manifest\.webmanifest|vendor\/qrcode\.(mjs|txt)|vendor\/qrcode-LICENSE\.txt|vendor\/tz-lookup\.js|vendor\/tz-lookup-LICENSE\.txt|vendor\/pdf\.(min|worker\.min)\.js|vendor\/pdf-LICENSE\.txt|assets\/[a-z0-9-]{1,60}\.(svg|woff2|jpg|png|txt))$/

const list = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? list(full, base) : [path.relative(base, full).split(path.sep).join('/')]
})

fs.rmSync(out, { recursive: true, force: true })
fs.cpSync(siteDir, out, { recursive: true })
fs.writeFileSync(path.join(out, '.nojekyll'), '')
console.log(`Web app: ${list(siteDir).length} files from ${siteDir}`)

let privateKey = process.env.OTA_PRIVATE_KEY
if (!privateKey) {
  console.log('OTA_PRIVATE_KEY is not set: the web app is published, but no app update.')
  process.exit(0)
}
if (!privateKey.includes('\n')) privateKey = privateKey.replace(/\\n/g, '\n')

const files = list(webDir).sort()
const skipped = files.filter(file => !allowed.test(file))
if (skipped.length) console.log(`Not part of the update (the app never serves them): ${skipped.join(', ')}`)
const included = files.filter(file => allowed.test(file))
if (!included.includes('index.html')) throw new Error('index.html is missing from ' + webDir)

const now = new Date(Number(args.now) || Date.now())
const version = Math.floor(now.getTime() / 60000)            // minutes since 1970: always increasing
const pad = value => String(value).padStart(2, '0')
const label = `${pad(now.getUTCFullYear() % 100)}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
const minApkFile = 'android/ota-min-apk.txt'
const minApk = Number(args['min-apk'] ?? (fs.existsSync(minApkFile) ? fs.readFileSync(minApkFile, 'utf8').trim() : 0))

const lines = ['geoziptag-ota 1', `version ${version}`, `label ${label}`, `min-apk ${minApk}`]
const otaDir = path.join(out, 'ota')
for (const file of included) {
  const data = fs.readFileSync(path.join(webDir, file))
  lines.push(`file ${crypto.createHash('sha256').update(data).digest('hex')} ${data.length} ${file}`)
  fs.mkdirSync(path.dirname(path.join(otaDir, 'files', file)), { recursive: true })
  fs.writeFileSync(path.join(otaDir, 'files', file), data)
}
const manifest = Buffer.from(lines.join('\n') + '\n', 'utf8')
const signature = crypto.sign('sha256', manifest, { key: privateKey, dsaEncoding: 'der' })
fs.writeFileSync(path.join(otaDir, 'manifest.txt'), manifest)
fs.writeFileSync(path.join(otaDir, 'manifest.txt.sig'), signature.toString('base64') + '\n')
console.log(`Update ${label} (version ${version}, needs app version code >= ${minApk}): ${included.length} files, signed.`)
