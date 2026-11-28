// Console-to-service request signing (contract GEOZIPTAG_ENTITLEMENT_SHAPE 0.1.1, section 6).
// signature = lower-case hex HMAC-SHA256(secret, timestamp + "." + METHOD + "." + path + "." + body)
import { enc, fromHex, toHex } from './util.ts'

export const MAX_SKEW_SECONDS = 300

export function signedText(
  timestamp: string,
  method: string,
  path: string,
  body: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const head = enc.encode(`${timestamp}.${method.toUpperCase()}.${path}.`)
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

async function key(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ])
}

export async function sign(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: Uint8Array = new Uint8Array(),
): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await key(secret, 'sign'),
    signedText(timestamp, method, path, body),
  )
  return toHex(new Uint8Array(mac))
}

/**
 * True when the signature matches and the timestamp is within MAX_SKEW_SECONDS either way (old or ahead).
 * The comparison is done by WebCrypto's HMAC verify, which is constant time.
 */
export async function verify(
  secret: string,
  timestamp: string,
  signature: string,
  method: string,
  path: string,
  body: Uint8Array,
  nowSeconds: number,
): Promise<boolean> {
  if (!/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false
  const sig = fromHex(signature)
  if (!sig || sig.length !== 32) return false
  return await crypto.subtle.verify(
    'HMAC',
    await key(secret, 'verify'),
    sig,
    signedText(timestamp, method, path, body),
  )
}
