// Redeem code generation and normalisation.
import { enc, toHex } from './util.ts'

export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 31 characters, no I L O 0 1
const CODE_LENGTH = 8

/** Ignore case, spaces and hyphens. */
export const normaliseCode = (typed: string): string => typed.toUpperCase().replace(/[\s-]/g, '')

export const formatCode = (normalised: string): string => `${normalised.slice(0, 4)}-${normalised.slice(4)}`

export const newProposalId = (): string => 'p_' + toHex(crypto.getRandomValues(new Uint8Array(16)))

/**
 * The code for a proposal: 8 characters of ALPHABET drawn without bias from HMAC-SHA256(pepper, proposal id | counter).
 * The proposal id is 128 random bits from the platform's CSPRNG, and the pepper is a function secret, so the code is
 * unpredictable. It is derived instead of stored so that the readable code is never in the database (not even in
 * the idempotency record) and a confirm retried with the same key can still show it to the caller that made it.
 */
export async function deriveCode(pepper: string, proposalId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [
      'sign',
    ],
  )
  let out = ''
  for (let block = 0; out.length < CODE_LENGTH; block++) {
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, enc.encode(`code-v1|${proposalId}|${block}`)),
    )
    for (const b of mac) {
      if (b >= 248) continue // 248 = 31 * 8: reject the top of the byte range so every character is equally likely
      out += ALPHABET[b % ALPHABET.length]
      if (out.length === CODE_LENGTH) break
    }
  }
  return out
}
