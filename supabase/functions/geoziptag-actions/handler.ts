// The router: URL and method to action, authentication, envelope. Everything below is built from the manifest.
import manifest from './manifest.json' with { type: 'json' }
import { checkEntitlement, getPublicKeys, joinTeam, redeemCode } from './actions/app.ts'
import { reads } from './actions/reads.ts'
import { writes } from './actions/writes.ts'
import { type Ctx, type Deps, VERSION } from './context.ts'
import { verify } from './hmac.ts'
import { newProposalId } from './codes.ts'
import { CursorError } from './store.ts'
import { coerceQuery, validate } from './validate.ts'
import { ApiError, dec, fail, iso } from './util.ts'

const BASE = '/geoziptag-actions'
const MAX_BODY = 32_768
const PROPOSAL_TTL_MS = 15 * 60_000
const ADMIN_ROLES = ['owner', 'operator']
const KEY_RE = /^[A-Za-z0-9_\-]{8,128}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_\-]{1,128}$/

interface ManifestAction {
  name: string
  kind: 'read' | 'write'
  scope: 'admin' | 'user'
  // deno-lint-ignore no-explicit-any
  params_schema: any
}
const actions = new Map((manifest.actions as ManifestAction[]).map((a) => [a.name, a]))

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const ok = (data: unknown, meta: Record<string, unknown> = {}) => json(200, { success: true, data, meta })

// The English text goes in both fields; Telugu is not needed for this service.
const errorResponse = (e: ApiError) =>
  json(e.status, { error: { code: e.code, message_en: e.message, message_te: e.message } })

/**
 * The path as the console signed it: strip only a leading /functions/v1 (the edge runtime may or may not show it),
 * keep the query string exactly as received.
 */
export function signedPath(url: URL): string {
  const p = url.pathname.startsWith('/functions/v1/')
    ? url.pathname.slice('/functions/v1'.length)
    : url.pathname
  return p + url.search
}

export function createHandler(deps: Deps) {
  const clock = deps.now ?? (() => new Date())

  async function admin(req: Request, url: URL, rest: string, body: Uint8Array): Promise<Response> {
    const { config, store } = deps
    const now = clock()
    if (!config.consoleSecret) throw fail(503, 'NOT_CONFIGURED', 'Admin calls are not configured')
    const h = req.headers
    const timestamp = h.get('x-console-timestamp') ?? ''
    const valid = await verify(
      config.consoleSecret,
      timestamp,
      h.get('x-console-signature') ?? '',
      req.method,
      signedPath(url),
      body,
      Math.floor(now.getTime() / 1000),
    )
    // 401 for anything wrong with the credential. Nothing below runs, and nothing is written.
    if (!valid) throw fail(401, 'BAD_SIGNATURE', 'The request signature is missing, wrong or out of date')
    const requestId = h.get('x-request-id') ?? ''
    if (!REQUEST_ID_RE.test(requestId)) {
      throw fail(401, 'BAD_REQUEST_ID', 'X-Request-Id is missing or malformed')
    }
    const fresh = await store.tx((tx) => tx.claimRequestId(requestId, now))
    if (!fresh) throw fail(401, 'REPLAY', 'This request id was already used')
    const actor = (h.get('x-console-actor') ?? '').slice(0, 80)
    const role = (h.get('x-console-role') ?? '').slice(0, 40)
    if (!actor) throw fail(401, 'NO_ACTOR', 'X-Console-Actor is missing')

    const audit = (phase: string, outcome: string, detail: Record<string, unknown> | null, tx: Ctx['tx']) =>
      tx.audit({
        request_id: requestId,
        actor,
        role,
        action: rest.split('/')[0],
        phase,
        outcome,
        at: now,
        detail,
      })
    const auditAlone = (phase: string, outcome: string, detail: Record<string, unknown>) =>
      store.tx((tx) => audit(phase, outcome, detail, tx)).catch(() => {})

    if (!ADMIN_ROLES.includes(role)) {
      await auditAlone('auth', 'denied', { code: 'ROLE_NOT_ALLOWED' })
      throw fail(403, 'ROLE_NOT_ALLOWED', 'This role may not use this action')
    }

    const [name, step, extra] = rest.split('/')
    const action = actions.get(name)
    if (!action || action.scope !== 'admin' || extra !== undefined) {
      throw fail(404, 'UNKNOWN_ACTION', 'Unknown action')
    }
    const meta = { request_id: requestId }
    const phase = action.kind === 'read' ? 'read' : step === 'confirm' ? 'confirm' : 'propose'
    const ctxOf = (tx: Ctx['tx']): Ctx => ({ tx, now, actor, role, requestId, config })

    try {
      if (action.kind === 'read') {
        if (req.method !== 'GET' || step !== undefined) throw fail(404, 'UNKNOWN_ACTION', 'Unknown action')
        const params = validate(action.params_schema, coerceQuery(action.params_schema, url.searchParams))
        const data = await store.tx(async (tx) => {
          const out = await reads[name](ctxOf(tx), params)
          await audit('read', 'ok', null, tx)
          return out
        })
        return ok(data, meta)
      }

      if (req.method !== 'POST' || (step !== 'propose' && step !== 'confirm')) {
        throw fail(404, 'UNKNOWN_ACTION', 'Unknown action')
      }
      const parsed = parseJson(body)
      const w = writes[name]

      if (step === 'propose') {
        const params = validate(action.params_schema, parsed)
        const data = await store.tx(async (tx) => {
          const ctx = ctxOf(tx)
          const summary = await w.check(ctx, params)
          const proposal = {
            id: newProposalId(),
            action: name,
            actor,
            params,
            created_at: now,
            expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS),
            confirmed_key: null,
            result: null,
          }
          await tx.insertProposal(proposal)
          await audit('propose', 'ok', { proposal_id: proposal.id }, tx)
          return { proposal_id: proposal.id, action: name, expires_at: iso(proposal.expires_at), summary }
        })
        return ok(data, meta)
      }

      // confirm
      const { proposal_id, idempotency_key } = validate(CONFIRM_SCHEMA, parsed) as {
        proposal_id: string
        idempotency_key: string
      }
      const stored = await store.tx(async (tx) => {
        const ctx = ctxOf(tx)
        const proposal = await tx.getProposal(proposal_id, true)
        const seen = (await tx.getIdempotency(idempotency_key, name)) as {
          proposal_id: string
          data: unknown
        } | null
        if (seen) {
          // The same key again: the first result, and nothing is done twice.
          if (seen.proposal_id !== proposal_id) {
            throw fail(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'This idempotency key was used for a different proposal',
            )
          }
          return seen.data
        }
        if (!proposal || proposal.action !== name || proposal.actor !== actor) {
          throw fail(409, 'UNKNOWN_PROPOSAL', 'No such proposal from you for this action: propose again')
        }
        if (proposal.confirmed_key !== null) {
          throw fail(
            409,
            'ALREADY_CONFIRMED',
            'This proposal was already confirmed with a different idempotency key',
          )
        }
        if (proposal.expires_at <= now) {
          throw fail(409, 'PROPOSAL_EXPIRED', 'This proposal expired: propose again')
        }
        await w.check(ctx, proposal.params)
        const data = await w.apply(ctx, proposal.params, { proposalId: proposal_id })
        await tx.markConfirmed(proposal_id, idempotency_key, data)
        await tx.putIdempotency(idempotency_key, name, { proposal_id, data }, now)
        await audit('confirm', 'ok', { proposal_id }, tx)
        return data
      })
      return ok(
        w.present ? await w.present(stored, { proposalId: proposal_id, pepper: config.pepper! }) : stored,
        meta,
      )
    } catch (e) {
      if (e instanceof ApiError) await auditAlone(phase, 'rejected', { code: e.code, status: e.status })
      else await auditAlone(phase, 'error', { code: 'INTERNAL' })
      throw e
    }
  }

  async function publicAction(req: Request, url: URL, name: string, body: Uint8Array): Promise<Response> {
    const now = clock()
    const action = actions.get(name)!
    const call = () => ({
      deps,
      now,
      ip: (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? '').split(',')[0]
        .trim() || 'unknown',
      bearer: /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null,
      body: {} as Record<string, unknown>,
    })
    if (name === 'get_public_keys') {
      validate(action.params_schema, coerceQuery(action.params_schema, url.searchParams))
      return ok(getPublicKeys(deps.config))
    }
    const c = call()
    c.body = validate(action.params_schema, parseJson(body))
    if (name === 'redeem_code') return ok(await redeemCode(c))
    if (name === 'check_entitlement') return ok(await checkEntitlement(c))
    return ok(await joinTeam(c))
  }

  return async function handle(req: Request): Promise<Response> {
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const url = new URL(req.url)
      const path = signedPath(url).split('?')[0]
      if (!path.startsWith(BASE + '/')) throw fail(404, 'NOT_FOUND', 'Not found')
      const rest = path.slice(BASE.length + 1).replace(/\/+$/, '')

      if (req.method === 'GET' && rest === 'health') return json(200, { ok: true, version: VERSION })
      if (req.method === 'GET' && rest === 'manifest') return json(200, manifest)

      const body = new Uint8Array(await req.arrayBuffer())
      if (body.length > MAX_BODY) throw fail(400, 'BODY_TOO_LARGE', 'Request too large')

      const first = rest.split('/')[0]
      const action = actions.get(first)
      if (action?.scope === 'user' && rest === first) {
        const method = manifestMethod(first)
        if (req.method !== method) throw fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
        return await publicAction(req, url, first, body)
      }
      if (action?.scope === 'admin' || (action && action.scope === 'user')) {
        if (action.scope === 'user') throw fail(404, 'UNKNOWN_ACTION', 'Unknown action')
        return await admin(req, url, rest, body)
      }
      // Unknown names also need the credential before they get an answer, but a 404 reveals nothing the manifest does not.
      throw fail(404, 'UNKNOWN_ACTION', 'Unknown action')
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e)
      if (e instanceof CursorError) {
        return errorResponse(fail(422, 'INVALID_PARAMS', 'Invalid parameters (cursor)'))
      }
      console.error('geoziptag-actions: unhandled', e instanceof Error ? e.name : typeof e)
      return errorResponse(fail(500, 'INTERNAL', 'Something went wrong'))
    }
  }
}

function manifestMethod(name: string): string {
  const a = (manifest.actions as { name: string; method?: string }[]).find((x) => x.name === name)
  return a?.method ?? 'POST'
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(dec.decode(body))
  } catch {
    throw fail(400, 'BAD_JSON', 'The request body is not valid JSON')
  }
}

const CONFIRM_SCHEMA = {
  type: 'object',
  required: ['proposal_id', 'idempotency_key'],
  additionalProperties: false,
  properties: {
    proposal_id: { type: 'string', minLength: 1, maxLength: 200 },
    idempotency_key: { type: 'string', pattern: KEY_RE.source },
  },
}
