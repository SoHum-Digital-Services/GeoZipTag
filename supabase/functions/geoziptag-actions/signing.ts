// ES256 entitlement signing (contract section 4) and the keyed hashes the service stores.
import { addDays, b64url, enc, fromB64, iso, toHex } from './util.ts'

export type SubjectKind = 'install' | 'team' | 'account'
export type Source = 'paid' | 'store' | 'coupon' | 'trial' | 'team' | 'admin'

export interface Signable {
  subject: { kind: SubjectKind; id: string }
  source: Source
  starts_at: Date
  ends_at: Date | null
  enabled: boolean
  team_id?: string | null
}

export interface SignedEntitlement {
  schema: 'sohum.geoziptag.entitlement.signed/1'
  alg: 'ES256'
  key_id: string
  payload_b64: string
  signature_b64: string
}

const CHECK_AFTER_MS = 24 * 3_600_000
const GRACE_DAYS = 7

/** Builds sohum.geoziptag.entitlement.payload/1. grace_until is issued_at + 7 days, never past ends_at. */
export function buildPayload(e: Signable, keyId: string, now: Date) {
  const issued = new Date(Math.floor(now.getTime() / 1000) * 1000)
  let grace = addDays(issued, GRACE_DAYS)
  if (e.ends_at && e.ends_at.getTime() < grace.getTime()) grace = e.ends_at
  return {
    schema: 'sohum.geoziptag.entitlement.payload/1',
    subject: { kind: e.subject.kind, id: e.subject.id },
    plan: 'pro',
    source: e.source,
    starts_at: iso(e.starts_at),
    ends_at: e.ends_at ? iso(e.ends_at) : null,
    enabled: e.enabled,
    issued_at: iso(issued),
    check_after: iso(new Date(issued.getTime() + CHECK_AFTER_MS)),
    grace_until: iso(grace),
    key_id: keyId,
    ...(e.team_id ? { team_id: e.team_id } : {}),
  }
}

export interface Signer {
  keyId: string
  sign(e: Signable, now: Date): Promise<SignedEntitlement>
}

/** `privateKeyB64` is the PKCS8 DER of an ECDSA P-256 key, standard base64 (the GEOZIPTAG_SIGNING_KEY secret). */
export function makeSigner(privateKeyB64: string, keyId: string): Signer {
  let imported: Promise<CryptoKey> | undefined
  const load = () =>
    imported ??= crypto.subtle.importKey(
      'pkcs8',
      fromB64(privateKeyB64.trim()),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  return {
    keyId,
    async sign(e, now) {
      const payload = enc.encode(JSON.stringify(buildPayload(e, keyId, now)))
      // WebCrypto ECDSA returns the raw r||s (64 bytes), which is what the contract wants.
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await load(), payload),
      )
      return {
        schema: 'sohum.geoziptag.entitlement.signed/1',
        alg: 'ES256',
        key_id: keyId,
        payload_b64: b64url(payload),
        signature_b64: b64url(sig),
      }
    },
  }
}

/** Keyed hash (HMAC-SHA256 with the pepper) under a domain prefix, so code hashes and install hashes never collide. */
export async function keyedHash(
  pepper: string,
  domain: 'code' | 'install' | 'ip',
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [
      'sign',
    ],
  )
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${domain}|${value}`))))
}
