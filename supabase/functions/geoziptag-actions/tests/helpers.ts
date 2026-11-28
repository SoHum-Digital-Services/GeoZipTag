// deno-lint-ignore-file no-explicit-any
// Test harness: the handler wired to a fake (in-memory) or a local Postgres store, with throwaway generated keys.
// Nothing here is a real key or secret: they are made fresh in every run and never written anywhere.
import { assert, assertEquals } from '@std/assert'
import { createHandler } from '../handler.ts'
import { sign } from '../hmac.ts'
import { type Config } from '../context.ts'
import { makeSigner } from '../signing.ts'
import type { Store } from '../store.ts'
import { b64url } from '../util.ts'
import { MemoryStore } from './memory_store.ts'
import { errorsFor, type Shape } from './schemas.ts'

export const NOW = new Date('2026-12-01T09:30:00Z')
export const SECRET = crypto.randomUUID() + crypto.randomUUID()
export const PEPPER = crypto.randomUUID() + crypto.randomUUID()

export async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const std = (b: Uint8Array) => btoa(String.fromCharCode(...b))
  return { privateB64: std(pkcs8), publicB64: std(spki), publicKey: pair.publicKey }
}

export const TOKENS: Record<string, string> = {} // test bearer token -> account id
export const verifyToken = (t: string) => Promise.resolve(TOKENS[t] ?? null)

export interface Env {
  store: Store
  mem?: MemoryStore
  clock: { now: Date }
  config: Config
  keys: Awaited<ReturnType<typeof makeKeys>>
  handle: (req: Request) => Promise<Response>
  addTeam(id: string, name: string, code: string): Promise<void>
  dump(): Promise<string>
  counts(): Promise<Record<string, number>>
  close(): Promise<void>
  /** Signed admin call. Returns the response. */
  admin(method: 'GET' | 'POST', path: string, body?: unknown, o?: AdminOpts): Promise<Response>
  /** Propose then confirm with a fresh key; returns the confirm data. */
  write(name: string, params: Record<string, unknown>, o?: AdminOpts): Promise<any>
  read(name: string, params?: Record<string, unknown>): Promise<any>
  app(
    method: 'GET' | 'POST',
    name: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>
  /** Redeem helper. */
  redeem(installId: string, code: string): Promise<Response>
}

export interface AdminOpts {
  role?: string
  actor?: string
  requestId?: string
  timestamp?: string
  secret?: string
  signature?: string
  prefix?: string // '' or '/functions/v1'
  rawBody?: string
}

let n = 0
export const rid = () => `req-${++n}-${crypto.randomUUID().slice(0, 8)}`
export const uuid = () => crypto.randomUUID()
export const qs = (p: Record<string, unknown>) =>
  new URLSearchParams(Object.keys(p).sort().map((k) => [k, String(p[k])])).toString()

export async function makeEnv(
  kind: 'memory' | 'pg',
  extra: { pg?: () => Promise<PgHarness> } = {},
): Promise<Env> {
  const keys = await makeKeys()
  const clock = { now: new Date(NOW) }
  const config: Config = {
    consoleSecret: SECRET,
    pepper: PEPPER,
    signer: makeSigner(keys.privateB64, 'k-test'),
    publicKeys: {
      schema: 'sohum.geoziptag.public_keys/1',
      keys: [{
        key_id: 'k-test',
        alg: 'ES256',
        public_key_b64: keys.publicB64,
        not_before: '2026-12-01T00:00:00Z',
        retired_at: null,
      }],
    },
  }
  let store: Store
  let mem: MemoryStore | undefined
  let pg: PgHarness | undefined
  if (kind === 'memory') store = mem = new MemoryStore()
  else {
    pg = await extra.pg!()
    store = pg.store
  }
  const handle = createHandler({ store, config, verifyToken, now: () => new Date(clock.now) })

  const env: Env = {
    store,
    mem,
    clock,
    config,
    keys,
    handle,
    addTeam: async (id, name, code) => {
      if (mem) mem.state.teams.push({ team_id: id, name, code })
      else await pg!.addTeam(id, name, code)
    },
    dump:
      async () => (mem
        ? JSON.stringify(mem.state, (_k, v) => (v instanceof Map ? [...v] : v))
        : await pg!.dump()),
    counts: async () => (mem ? mem.counts() : await pg!.counts()),
    close: async () => {
      await pg?.close()
    },

    async admin(method, path, body, o = {}) {
      const raw = o.rawBody ?? (body === undefined ? '' : JSON.stringify(body))
      const ts = o.timestamp ?? String(Math.floor(clock.now.getTime() / 1000))
      const sig = o.signature ??
        await sign(o.secret ?? SECRET, ts, method, path, new TextEncoder().encode(raw))
      const headers: Record<string, string> = {
        'x-console-timestamp': ts,
        'x-console-signature': sig,
        'x-console-actor': o.actor ?? 'console-user-1',
        'x-console-role': o.role ?? 'owner',
        'x-request-id': o.requestId ?? rid(),
      }
      if (raw) headers['content-type'] = 'application/json'
      const url = `https://example.test${o.prefix ?? '/functions/v1'}${path}`
      return await handle(new Request(url, { method, headers, body: raw || undefined }))
    },
    async write(name, params, o = {}) {
      const propose = await env.admin('POST', `/geoziptag-actions/${name}/propose`, params, o)
      const p = await propose.json()
      assertEquals(propose.status, 200, JSON.stringify(p))
      const key = `key-${crypto.randomUUID()}`
      const confirm = await env.admin('POST', `/geoziptag-actions/${name}/confirm`, {
        proposal_id: p.data.proposal_id,
        idempotency_key: key,
      }, o)
      const c = await confirm.json()
      assertEquals(confirm.status, 200, JSON.stringify(c))
      return c.data
    },
    async read(name, params = {}) {
      const q = qs(params)
      const res = await env.admin('GET', `/geoziptag-actions/${name}${q ? `?${q}` : ''}`)
      const j = await res.json()
      assertEquals(res.status, 200, JSON.stringify(j))
      return j.data
    },
    app(method, name, body, headers = {}) {
      return handle(
        new Request(`https://example.test/functions/v1/geoziptag-actions/${name}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
    },
    redeem: (installId, code) => env.app('POST', 'redeem_code', { install_id: installId, code }),
  }
  return env
}

export interface PgHarness {
  store: Store
  addTeam(id: string, name: string, code: string): Promise<void>
  dump(): Promise<string>
  counts(): Promise<Record<string, number>>
  close(): Promise<void>
}

/** Decodes a signed envelope and checks its signature with the env's public key. */
export async function openSigned(env: Env, signed: { payload_b64: string; signature_b64: string }) {
  assertEquals(errorsFor('entitlement#signed', signed), [])
  const fromB = (s: string) =>
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const payloadBytes = fromB(signed.payload_b64)
  const good = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    env.keys.publicKey,
    fromB(signed.signature_b64),
    payloadBytes,
  )
  assert(good, 'signature must verify')
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes))
  assertEquals(errorsFor('entitlement#payload', payload), [])
  return payload
}

export const checkShape = (shape: Shape, v: unknown) =>
  assertEquals(errorsFor(shape, v), [], JSON.stringify(v))
export { b64url }
