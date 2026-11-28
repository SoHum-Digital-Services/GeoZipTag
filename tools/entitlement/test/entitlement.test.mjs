// Acceptance tests E1 to E8 (docs/briefs/GEOZIPTAG_APP_frontend.md). Run: node --test tools/entitlement/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64url, cameraSource, contract, entitlementBlock, load, makeKeyPair, memoryStorage, ok, reply, root, sign } from './harness.mjs'

const INSTALL = '7b0f1d52-3c1e-4c0a-9f2e-5a6d8e1b2c34'
const base = () => structuredClone(contract('sohum-geoziptag-entitlement-payload'))   // the contract's example payload
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')
const DAY = 864e5
const T = Date.parse('2026-12-01T10:00:00Z')

async function setup(options = {}) {
  const pair = await makeKeyPair()
  const other = await makeKeyPair()
  const storage = options.storage || memoryStorage({ geoziptagInstallId: INSTALL })
  const env = load({ ...options, storage, keys: [{ key_id: 'k1', alg: 'ES256', public_key_b64: pair.spkiB64 }] })
  return { pair, other, storage, ...env }
}

test('E1: the example payload signed with the test key verifies; a flipped byte, a wrong key id and another key do not', async () => {
  const { api, pair, other } = await setup()
  const signed = await sign(base(), pair)
  assert.ok(await api.verifyEnvelope(signed), 'valid signature accepted')

  const bytes = Buffer.from(signed.payload_b64, 'base64url')
  bytes[10] ^= 0x01
  assert.equal(await api.verifyEnvelope({ ...signed, payload_b64: b64url(bytes) }), undefined, 'flipped byte rejected')
  assert.equal(await api.verifyEnvelope({ ...signed, key_id: 'k2' }), undefined, 'unknown key id rejected')
  assert.equal(await api.verifyEnvelope(await sign(base(), other)), undefined, 'a signature from another key rejected')
})

test('E2: entitled() before starts_at, inside, after ends_at, disabled, after grace_until', async () => {
  const { api, pair } = await setup()
  const payload = (over) => ({ ...base(), starts_at: '2026-12-01T09:30:00Z', ends_at: '2026-12-31T09:30:00Z', grace_until: '2026-12-08T09:30:00Z', ...over })
  const set = async (p) => assert.equal(await api.acceptReply(await sign(p, pair)), true)

  await set(payload({}))
  assert.equal(api.entitled(Date.parse('2026-12-01T09:00:00Z')), false, 'before starts_at')
  assert.equal(api.entitled(Date.parse('2026-12-02T09:00:00Z')), true, 'inside')
  assert.equal(api.entitled(Date.parse('2027-01-01T00:00:00Z')), false, 'after ends_at')
  assert.equal(api.entitled(Date.parse('2026-12-09T00:00:00Z')), false, 'after grace_until (offline)')
  await set(payload({ enabled: false }))
  assert.equal(api.entitled(Date.parse('2026-12-02T09:00:00Z')), false, 'enabled:false')
  await set(payload({ ends_at: null }))
  assert.equal(api.entitled(Date.parse('2026-12-02T09:00:00Z')), true, 'no end date')
})

test('E3: a stored entitlement edited in storage is not trusted', async () => {
  const { api, pair, storage } = await setup()
  const good = await sign({ ...base(), starts_at: '2026-12-01T09:30:00Z', ends_at: '2027-12-01T09:30:00Z', grace_until: '2026-12-08T09:30:00Z' }, pair)
  await api.acceptReply(good)
  assert.equal(api.entitled(T), true)

  const tamper = async (edit) => {
    storage.setItem('geoziptagEntitlement', JSON.stringify(edit))
    await api.loadEntitlement()
    return api.entitled(T)
  }
  assert.equal(await tamper(good), true, 'untouched storage still verifies on load')
  const payload = JSON.parse(Buffer.from(good.payload_b64, 'base64url').toString())
  payload.ends_at = '2099-01-01T00:00:00Z'
  assert.equal(await tamper({ ...good, payload_b64: b64url(JSON.stringify(payload)) }), false, 'payload edited')
  const signature = Buffer.from(good.signature_b64, 'base64url'); signature[3] ^= 0xff
  assert.equal(await tamper({ ...good, signature_b64: b64url(signature) }), false, 'signature edited')
  assert.equal(await tamper({ junk: true }), false, 'junk')
  storage.setItem('geoziptagEntitlement', '{not json')
  await api.loadEntitlement()
  assert.equal(api.entitled(T), false, 'not even JSON')
})

test('E4: another install, a plan other than pro and an unknown schema are rejected', async () => {
  const { api, pair } = await setup()
  const verify = async (over) => api.verifyEnvelope(await sign({ ...base(), ...over }, pair))
  assert.ok(await verify({}), 'the example itself is fine')
  assert.equal(await verify({ subject: { kind: 'install', id: '00000000-0000-4000-8000-000000000000' } }), undefined, 'subject of another install')
  assert.equal(await verify({ plan: 'basic' }), undefined, 'plan other than pro')
  assert.equal(await verify({ schema: 'sohum.geoziptag.entitlement.payload/2' }), undefined, 'unknown schema')
  assert.equal(await verify({ subject: { kind: 'account', id: INSTALL } }), undefined, 'an account entitlement is not for the install check')
  assert.equal(await verify({ key_id: 'other' }), undefined, 'payload key id must match the envelope')
})

test('E5: the daily check keeps a stored entitlement on failure until grace ends; null clears; enabled:false turns Pro off at once', async () => {
  const mk = async () => {
    const fetchState = { next: () => { throw new Error('offline') } }
    const env = await setup({ fetchImpl: (u, i) => fetchState.next(u, i) })
    return { ...env, fetchState }
  }
  const payload = { ...base(), starts_at: '2026-12-01T09:30:00Z', ends_at: '2027-12-01T09:30:00Z', check_after: '2026-12-02T09:30:00Z', grace_until: '2026-12-08T09:30:00Z' }
  const due = Date.parse('2026-12-03T00:00:00Z')

  // a failed call (offline, then 500) changes nothing
  let t = await mk()
  await t.api.acceptReply(await sign(payload, t.pair))
  assert.equal(await t.api.checkEntitlementNow({ now: due }), false)
  t.fetchState.next = () => reply(500, { error: { code: 'INTERNAL' } })
  assert.equal(await t.api.checkEntitlementNow({ now: due }), false)
  assert.equal(t.api.entitled(due), true, 'still on inside the grace period')
  assert.equal(t.api.entitled(Date.parse('2026-12-08T09:30:01Z')), false, 'banner returns after grace')
  assert.equal(t.calls.length, 2, 'it did call the service twice')

  // not due yet: no call
  t = await mk()
  await t.api.acceptReply(await sign(payload, t.pair))
  await t.api.checkEntitlementNow({ now: Date.parse('2026-12-02T00:00:00Z') })
  assert.equal(t.calls.length, 0, 'no call before check_after')

  // data: null clears
  t = await mk()
  await t.api.acceptReply(await sign(payload, t.pair))
  t.fetchState.next = () => ok(null)
  assert.equal(await t.api.checkEntitlementNow({ now: due }), true)
  assert.equal(t.api.entitled(due), false)
  assert.equal(t.storage.getItem('geoziptagEntitlement'), null, 'stored copy removed')
  assert.deepEqual(JSON.parse(t.calls[0].init.body), { install_id: INSTALL }, 'only the install id is sent')

  // enabled:false takes effect at once
  t = await mk()
  await t.api.acceptReply(await sign(payload, t.pair))
  t.fetchState.next = async () => ok(await sign({ ...payload, enabled: false, issued_at: iso(due), check_after: iso(due + DAY) }, t.pair))
  assert.equal(await t.api.checkEntitlementNow({ now: due }), true)
  assert.equal(t.api.entitled(due), false)

  // a reply that does not verify is ignored
  t = await mk()
  await t.api.acceptReply(await sign(payload, t.pair))
  t.fetchState.next = async () => ok(await sign({ ...payload, enabled: false }, t.other))
  assert.equal(await t.api.checkEntitlementNow({ now: due }), false)
  assert.equal(t.api.entitled(due), true, 'an untrusted reply changes nothing')
})

test('E5b: opening the app checks at once when this install holds an entitlement, even before the daily time; a phone that never used a code stays silent', async () => {
  const payload = { ...base(), starts_at: '2026-12-01T09:30:00Z', ends_at: '2027-12-01T09:30:00Z', check_after: '2026-12-02T09:30:00Z', grace_until: '2026-12-08T09:30:00Z' }
  const early = Date.parse('2026-12-01T12:00:00Z')   // well before check_after

  let t = await setup({ fetchImpl: () => ok(null) })
  await t.api.acceptReply(await sign(payload, t.pair))
  assert.equal(await t.api.checkEntitlementNow({ now: early }), false, 'not due: no call on a plain check')
  assert.equal(t.calls.length, 0)
  assert.equal(await t.api.checkEntitlementNow({ now: early, force: true }), true, 'forced on open: it asks')
  assert.equal(t.calls.length, 1)
  assert.equal(t.api.entitled(early), false, 'a revoke (null) takes effect at the next open')

  t = await setup({ fetchImpl: () => { throw new Error('offline') } })
  await t.api.acceptReply(await sign(payload, t.pair))
  assert.equal(await t.api.checkEntitlementNow({ now: early, force: true }), false)
  assert.equal(t.api.entitled(early), true, 'a failed open-check changes nothing (grace still applies)')

  t = await setup({ fetchImpl: () => ok(null) })
  assert.equal(await t.api.checkEntitlementNow({ now: early, force: true }), false)
  assert.equal(t.calls.length, 0, 'never redeemed and nothing stored: no call even when forced')

  assert.match(cameraSource, /openCheck\(\)\n  document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) openCheck\(\) \}\)/, 'launch and return to the front both use the open check')
  assert.match(cameraSource, /if \(now - lastOpenCheck < 60000\) return refreshEntitlement\(\)/, 'at most one forced check a minute')
})

test('E6: an entitled phone never calls adShow and calls adHide if shown; the banner returns when Pro lapses', async () => {
  const calls = []
  const android = { adShow: (...a) => calls.push(['show', ...a]), adHide: () => calls.push(['hide']) }
  const { api, pair, review } = await setup({ withAds: true, android })
  review.hidden = false

  api.syncAd()
  assert.deepEqual(calls.map(c => c[0]), ['show'], 'not entitled: the banner shows as today')
  assert.equal(api.getShown(), true)

  const now = Date.now()
  const proPayload = (over = {}) => ({ ...base(), starts_at: iso(now - DAY), ends_at: iso(now + DAY * 30), issued_at: iso(now), check_after: iso(now + DAY), grace_until: iso(now + DAY * 7), ...over })
  await api.acceptReply(await sign(proPayload(), pair))
  calls.length = 0
  api.syncAd()
  assert.deepEqual(calls.map(c => c[0]), ['hide'], 'entitled and shown: hidden')
  api.syncAd(); api.syncAd()
  assert.equal(calls.filter(c => c[0] === 'show').length, 0, 'adShow is never called while entitled')
  assert.equal(api.getShown(), false)

  await api.acceptReply(await sign(proPayload({ enabled: false }), pair))
  calls.length = 0
  api.syncAd()
  assert.deepEqual(calls.map(c => c[0]), ['show'], 'Pro lapsed: the banner shows again')
})

test('E6b: if checking Pro throws, the banner stays as it is today', async () => {
  const calls = []
  const android = { adShow: (...a) => calls.push(['show', ...a]), adHide: () => calls.push(['hide']) }
  const t = await setup({ withAds: true, android })
  t.context.crypto = undefined   // nothing about WebCrypto works any more
  t.api.entitlementState.payload = {}   // a broken state that would make entitled() misbehave
  t.api.syncAd()
  assert.deepEqual(calls.map(c => c[0]), ['show'], 'the banner shows')
})

test('E7: ENTITLEMENTS_LIVE is false as committed; with it false there is no network call, no Pro, and the Redeem row is hidden', async () => {
  assert.match(cameraSource, /const ENTITLEMENTS_LIVE = false\b/, 'committed with the flag false')
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  assert.match(html, /<section id="proGroup"[^>]*\bhidden\b/, 'the Redeem group starts hidden')
  assert.match(cameraSource, /if \(ENTITLEMENTS_LIVE\) \{\n  \$\('proGroup'\)\.hidden = false/, 'only shown when the flag is on')

  const pair = await makeKeyPair()
  const storage = memoryStorage({ geoziptagInstallId: INSTALL, geoziptagRedeemed: '1' })
  const { api, calls } = load({ live: false, storage, keys: [{ key_id: 'k1', alg: 'ES256', public_key_b64: pair.spkiB64 }], fetchImpl: () => { throw new Error('must not be called') } })
  storage.setItem('geoziptagEntitlement', JSON.stringify(await sign({ ...base(), starts_at: '2020-01-01T00:00:00Z', ends_at: null }, pair)))
  await api.loadEntitlement()
  assert.equal(api.entitled(T), false, 'even a valid stored entitlement is ignored while the flag is off')
  assert.equal(await api.redeemEntitlementCode('HQ7K-M2WD'), 'offline')
  assert.equal(await api.checkEntitlementNow({ force: true }), false)
  assert.equal(calls.length, 0, 'no network call at all')
})

test('E8: redeem outcomes are generic, and no response text is ever shown', async () => {
  const run = async (fetchImpl, code = 'HQ7K-M2WD') => {
    const t = await setup({ fetchImpl })
    return { t, result: await t.api.redeemEntitlementCode(code) }
  }
  assert.equal((await run(() => reply(422, { error: { code: 'INVALID_CODE', message_en: 'That code is not valid.' } }))).result, 'invalid')
  assert.equal((await run(() => reply(429, { error: { code: 'RATE_LIMITED', message_en: 'Too many requests.' } }))).result, 'limited')
  assert.equal((await run(() => { throw new TypeError('Failed to fetch') })).result, 'offline')
  assert.equal((await run(() => reply(500, { error: { code: 'INTERNAL' } }))).result, 'offline')
  assert.equal((await run(() => ok(null))).result, 'offline', 'a redeem with no entitlement is not a success')
  assert.equal((await run(() => { throw new Error('must not be called') }, 'ab')).result, 'invalid', 'too-short codes are refused without a call')

  // a reply signed by a key the app does not trust is rejected
  const t1 = await setup({ fetchImpl: () => 'placeholder' })
  t1.context.fetch = async () => ok(await sign(base(), t1.other))
  assert.equal(await t1.api.redeemEntitlementCode('HQ7K-M2WD'), 'offline')
  assert.equal(t1.api.entitled(T), false)

  // a good redeem stores a verified entitlement and remembers that this install has redeemed
  const t2 = await setup({ fetchImpl: () => 'placeholder' })
  const now = Date.now()
  const good = await sign({ ...base(), starts_at: iso(now - 1000), ends_at: iso(now + DAY * 7), issued_at: iso(now), check_after: iso(now + DAY), grace_until: iso(now + DAY * 7) }, t2.pair)
  t2.context.fetch = async (url, init) => { t2.calls.push({ url, init }); return ok(good) }
  assert.equal(await t2.api.redeemEntitlementCode('  HQ7K-M2WD '), 'ok')
  assert.equal(t2.api.entitled(), true)
  assert.equal(t2.storage.getItem('geoziptagRedeemed'), '1')
  const sent = t2.calls[0]
  assert.equal(sent.url, 'https://ziebgspujtdzkiwyybsa.supabase.co/functions/v1/geoziptag-actions/redeem_code')
  assert.deepEqual(JSON.parse(sent.init.body), { install_id: INSTALL, code: 'HQ7K-M2WD' }, 'trimmed code and install id only')

  // the code never displays server text
  assert.doesNotMatch(entitlementBlock(), /message_en|message_te|error\.message/, 'the entitlement code never reads the server message')
  assert.match(cameraSource, /invalid: "This code can't be used\."/)
  assert.match(cameraSource, /offline: "Couldn't reach SoHum\. Try again\."/)
})

test('the bundled public key and endpoint are the ones supplied, and no secret is in the app code', () => {
  assert.match(cameraSource, /key_id: 'key-2026-11'/)
  assert.ok(cameraSource.includes('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDel0u7wCdMXi5+bLR5rTwT8t0I2c/RJmJ271/3E2ia5iUNzdH1ME6ntaN+WnNuv3mLxfCl5uvTZplITPSLIESQ=='))
  assert.match(cameraSource, /https:\/\/ziebgspujtdzkiwyybsa\.supabase\.co\/functions\/v1\/geoziptag-actions/)
  const secrets = /-----BEGIN [A-Z ]*PRIVATE KEY-----|MIGHAgEAMBMGByqGSM49|\bservice_role\b|sb_secret_|GEOZIPTAG_SIGNING_KEY|GEOZIPTAG_CONSOLE_SECRET|GEOZIPTAG_CODE_PEPPER/
  assert.doesNotMatch(entitlementBlock(), secrets, 'no private or service key material in the entitlement code')
  assert.doesNotMatch(cameraSource, secrets, 'none anywhere in the app script')
})

test('a new install id is a random UUID, kept and reused', async () => {
  const t = await setup({ storage: memoryStorage(), fetchImpl: () => ok(null) })
  const id = t.api.installId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(t.api.installId(), id, 'stable')
  assert.equal(t.storage.getItem('geoziptagInstallId'), id)
})
