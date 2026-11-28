// Loads the real entitlement code (and the banner-ad code) out of web/camera.js between marker comments, in a vm
// with stubbed browser globals, so the tests exercise what ships. Test keys are generated here, never committed.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const root = join(here, '..', '..', '..')
export const cameraSource = readFileSync(join(root, 'web', 'camera.js'), 'utf8')
export const contract = (name) => JSON.parse(readFileSync(join(root, 'supabase', 'functions', 'geoziptag-actions', 'tests', 'contract', `${name}.example.json`), 'utf8'))

function between(start, end) {
  const a = cameraSource.indexOf(start), b = cameraSource.indexOf(end)
  if (a < 0 || b < 0 || b < a) throw new Error(`markers not found: ${start}`)
  return cameraSource.slice(a, b + end.length)
}
export const entitlementBlock = () => between('// ---- Entitlement (start)', '// ---- Entitlement (end)')
export const adBlock = () => between('// ---- Banner ad (start)', '// ---- Banner ad (end)')

export const b64 = (bytes) => Buffer.from(bytes).toString('base64')
export const b64url = (bytes) => Buffer.from(bytes).toString('base64url')

export async function makeKeyPair() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey))
  return { privateKey: pair.privateKey, spkiB64: b64(spki) }
}
// A signed envelope exactly as the service builds it: payload as UTF-8 JSON bytes, signature raw r||s, both base64url.
export async function sign(payload, keyPair, keyId = 'k1') {
  const bytes = new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload))
  const signature = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, bytes))
  return { schema: 'sohum.geoziptag.entitlement.signed/1', alg: 'ES256', key_id: keyId, payload_b64: b64url(bytes), signature_b64: b64url(signature) }
}

export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)) },
    removeItem: (k) => { data.delete(k) },
    dump: () => Object.fromEntries(data)
  }
}

/**
 * Builds a context holding the entitlement block (and optionally the ad block). `live` sets ENTITLEMENTS_LIVE; the
 * trusted key list is replaced by `keys` (the test's own public key).
 */
export function load({ live = true, keys, storage = memoryStorage(), fetchImpl, withAds = false, android, doc } = {}) {
  let source = entitlementBlock()
  source = source.replace(/const ENTITLEMENTS_LIVE = (true|false)/, `const ENTITLEMENTS_LIVE = ${live}`)
  if (keys) source = source.replace(/const ENTITLEMENT_KEYS = \[[\s\S]*?\n\]/, `const ENTITLEMENT_KEYS = ${JSON.stringify(keys)}`)
  const calls = []
  const wrappedFetch = async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init) }
  const slot = { hidden: false, getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 60 }) }
  const review = { hidden: false }
  const elements = { adSlot: slot, review }
  const context = {
    crypto: webcrypto, localStorage: storage, fetch: wrappedFetch, atob, btoa, TextDecoder, TextEncoder, URL, Date, JSON, Promise, Number, String, Math,
    console, android: android || undefined,
    $: (id) => elements[id],
    document: doc || { hidden: false, querySelector: () => null, body: {}, addEventListener() {} },
    window: { addEventListener() {} }, MutationObserver: class { observe() {} }, requestAnimationFrame: (fn) => fn()
  }
  vm.createContext(context)
  const exported = '\n;({ ENTITLEMENTS_LIVE, ENTITLEMENT_KEYS, installId, verifyEnvelope, entitled, entitlementEnds, loadEntitlement, acceptReply, ' +
    'redeemEntitlementCode, checkEntitlementNow, entitlementState' + (withAds ? ', syncAd, adFree, getShown: () => adShown' : '') + ' })'
  const api = vm.runInContext((withAds ? adBlockAfter(source) : source) + exported, context)
  return { api, calls, storage, slot, review, context }
}
// The ad block follows the entitlement block in the file, so its source is simply appended (it needs `entitled`).
function adBlockAfter(source) { return source + '\n' + adBlock() }

export const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
export const ok = (data) => reply(200, { success: true, data, meta: {} })
