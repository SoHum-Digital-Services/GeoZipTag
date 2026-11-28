// Small shared helpers: errors, time, masking, base64url, hex.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export const fail = (status: number, code: string, message: string) => new ApiError(status, code, message)

/** ISO 8601 UTC without a zero millisecond part, like the contract's examples. */
export function iso(d: Date): string {
  return d.toISOString().replace(/\.000Z$/, 'Z')
}

export const isoOrNull = (d: Date | null): string | null => (d ? iso(d) : null)

/** First four and last four characters: the console's masking rule for install and account ids. */
export function mask(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  return Uint8Array.from(atob(std), (c) => c.charCodeAt(0))
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const enc = new TextEncoder()
export const dec = new TextDecoder()

export const DAY_MS = 86_400_000
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS)
