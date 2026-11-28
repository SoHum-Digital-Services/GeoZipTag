import { assert, assertEquals, assertNotEquals } from '@std/assert'
import manifest from '../manifest.json' with { type: 'json' }
import { sign, verify } from '../hmac.ts'
import { buildPayload, makeSigner } from '../signing.ts'
import { ALPHABET, deriveCode, normaliseCode } from '../codes.ts'
import { signedPath } from '../handler.ts'
import { errorsFor, readContractJson } from './schemas.ts'
import { makeKeys } from './helpers.ts'

Deno.test('S1 manifest.json equals the contract example; examples validate against the schemas', () => {
  assertEquals(manifest, readContractJson('geoziptag-manifest.example.json'))
  assertEquals((manifest.actions as unknown[]).length, 17)
  const live = Deno.env.get('SOHUM_CONTRACTS_DIR')
  if (live) {
    assertEquals(
      manifest,
      JSON.parse(Deno.readTextFileSync(`${live}/schemas/examples/geoziptag-manifest.example.json`)),
    )
  }
  const table: [string, Parameters<typeof errorsFor>[0]][] = [
    ['entitlement.example.json', 'entitlement'],
    ['entitlement-payload.example.json', 'entitlement#payload'],
    ['entitlement-signed.example.json', 'entitlement#signed'],
    ['public-keys.example.json', 'entitlement#public_keys'],
    ['redeem-code.example.json', 'redeem_code'],
    ['redemption.example.json', 'redemption'],
    ['team-plan.example.json', 'team_plan'],
    ['team-member.example.json', 'team_member'],
  ]
  for (const [f, shape] of table) {
    assertEquals(errorsFor(shape, readContractJson(`sohum-geoziptag-${f}`)), [], f)
  }
})

const VECTOR_SECRET = 'example-secret-not-real'
const VECTOR_PATH = '/geoziptag-actions/grant_entitlement/confirm'
const VECTOR_BODY = '{"proposal_id":"example","idempotency_key":"example"}'
const VECTOR_SIG = '6139f764fea5ed92963f9f99249d644eb41bd0c99a08c9b4d3fbe3e9e3f04c0c'
const te = (s: string) => new TextEncoder().encode(s)

Deno.test('S2 console test vector verifies; any change fails', async () => {
  const now = 1796000000
  assertEquals(await sign(VECTOR_SECRET, '1796000000', 'POST', VECTOR_PATH, te(VECTOR_BODY)), VECTOR_SIG)
  const v = (m: string, p: string, b: string, sig = VECTOR_SIG, at = now) =>
    verify(VECTOR_SECRET, '1796000000', sig, m, p, te(b), at)
  assert(await v('POST', VECTOR_PATH, VECTOR_BODY))
  assert(!await v('GET', VECTOR_PATH, VECTOR_BODY), 'method')
  assert(!await v('POST', VECTOR_PATH.replace('confirm', 'propose'), VECTOR_BODY), 'path')
  assert(!await v('POST', VECTOR_PATH + '?a=1', VECTOR_BODY), 'query string')
  assert(!await v('POST', VECTOR_PATH, VECTOR_BODY.replace('example"}', 'examplf"}')), 'one body byte')
  assert(
    !await v('POST', VECTOR_PATH, VECTOR_BODY, VECTOR_SIG.toUpperCase().replace(/[A-F]/g, 'A')),
    'wrong sig',
  )
  assert(!await v('POST', VECTOR_PATH, VECTOR_BODY, VECTOR_SIG, now + 301), 'old')
  assert(!await v('POST', VECTOR_PATH, VECTOR_BODY, VECTOR_SIG, now - 301), 'ahead')
  assert(await v('POST', VECTOR_PATH, VECTOR_BODY, VECTOR_SIG, now + 300))
})

Deno.test('path reconstruction handles both edge runtime forms', () => {
  assertEquals(
    signedPath(new URL('https://x/functions/v1/geoziptag-actions/a?b=1')),
    '/geoziptag-actions/a?b=1',
  )
  assertEquals(signedPath(new URL('https://x/geoziptag-actions/a?b=1')), '/geoziptag-actions/a?b=1')
})

Deno.test('S10 signed envelope verifies, grace never passes ends_at, tampering fails', async () => {
  const keys = await makeKeys()
  const signer = makeSigner(keys.privateB64, 'k1')
  const now = new Date('2026-12-01T09:30:00Z')
  const ends = new Date('2026-12-04T09:30:00Z')
  const s = await signer.sign({
    subject: { kind: 'install', id: crypto.randomUUID() },
    source: 'coupon',
    starts_at: now,
    ends_at: ends,
    enabled: true,
  }, now)
  assertEquals(errorsFor('entitlement#signed', s), [])
  const b = (x: string) =>
    Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const payload = b(s.payload_b64)
  const sig = b(s.signature_b64)
  assertEquals(sig.length, 64)
  const ok = (p: Uint8Array<ArrayBuffer>, g: Uint8Array<ArrayBuffer>) =>
    crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, g, p)
  assert(await ok(payload, sig))
  const parsed = JSON.parse(new TextDecoder().decode(payload))
  assertEquals(errorsFor('entitlement#payload', parsed), [])
  assertEquals(parsed.grace_until, parsed.ends_at)
  assertEquals(parsed.check_after, '2026-12-02T09:30:00Z')
  const bad = new Uint8Array(payload)
  bad[10] ^= 1
  assert(!await ok(bad, sig))
  const badSig = new Uint8Array(sig)
  badSig[3] ^= 1
  assert(!await ok(payload, badSig))
  assertEquals(
    buildPayload(
      {
        subject: { kind: 'install', id: 'x' },
        source: 'admin',
        starts_at: now,
        ends_at: null,
        enabled: true,
      },
      'k',
      now,
    ).grace_until,
    '2026-12-08T09:30:00Z',
  )
})

Deno.test('codes: normalisation and derivation use only the allowed alphabet', async () => {
  assertEquals(normaliseCode(' hq7k-m2wd '), 'HQ7KM2WD')
  const a = await deriveCode('pepper-a', 'p_1')
  assertEquals(a, await deriveCode('pepper-a', 'p_1'))
  assertNotEquals(a, await deriveCode('pepper-a', 'p_2'))
  assertNotEquals(a, await deriveCode('pepper-b', 'p_1'))
  assert([...a].every((c) => ALPHABET.includes(c)) && a.length === 8)
})
