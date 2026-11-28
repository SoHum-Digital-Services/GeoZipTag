// The four app (public) actions. No console credential here: rate limits protect redeem and check, and join_team needs a
// verified SoHum token. Redeem and join are not propose/confirm (pressing the button is the confirmation).
import type { Config, Ctx, Deps } from '../context.ts'
import { normaliseCode } from '../codes.ts'
import { keyedHash } from '../signing.ts'
import type { Store } from '../store.ts'
import { addDays, fail } from '../util.ts'
import { memberRecord, notConfigured, resolveForInstall } from './common.ts'

const HOUR_MS = 3_600_000

/** One generic error for an unknown, expired, disabled or used-up code, so codes cannot be probed. */
const invalidCode = () => fail(422, 'INVALID_CODE', 'That code is not valid.')

/**
 * Counts this call against each bucket in its own committed transaction (a rejected call must still count, so this
 * cannot share the main transaction, which rolls back on an error). Throws 429 if any bucket is over its limit.
 */
async function rateLimit(store: Store, now: Date, buckets: [string, number][]) {
  const windowStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)
  const over = await store.tx(async (tx) => {
    if (Math.random() < 0.02) await tx.prune(new Date(now.getTime() - 2 * HOUR_MS))
    let exceeded = false
    for (const [bucket, max] of buckets) if ((await tx.bump(bucket, windowStart)) > max) exceeded = true
    return exceeded
  })
  if (over) throw fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.')
}

export interface AppCall {
  deps: Deps
  now: Date
  body: Record<string, unknown>
  /** Raw source address, used only to key a rate-limit counter (as a keyed hash); never stored. */
  ip: string
  bearer: string | null
}

async function signedOrNull(config: Config, ctx: Ctx, installId: string, accountId?: string) {
  const signable = await resolveForInstall(ctx, installId, accountId)
  if (!signable) return null
  if (!config.signer) throw notConfigured('The signing key')
  return await config.signer.sign(signable, ctx.now)
}

const appCtx = (c: AppCall, tx: Ctx['tx']): Ctx => ({
  tx,
  now: c.now,
  actor: 'app',
  role: 'app',
  requestId: '-',
  config: c.deps.config,
})

export async function redeemCode(c: AppCall) {
  const { config, store } = c.deps
  if (!config.pepper) throw notConfigured('The code pepper')
  if (!config.signer) throw notConfigured('The signing key')
  const installId = (c.body.install_id as string).toLowerCase()
  const installHash = await keyedHash(config.pepper, 'install', installId)
  await rateLimit(store, c.now, [
    [`redeem:i:${installHash}`, 10],
    [`redeem:ip:${await keyedHash(config.pepper, 'ip', c.ip)}`, 60],
  ])
  const codeHash = await keyedHash(config.pepper, 'code', normaliseCode(c.body.code as string))

  // One transaction: the row lock on the code makes the limit check, the count, the entitlement and the redemption
  // row atomic, so two phones cannot both take the last use.
  return await store.tx(async (tx) => {
    const ctx = appCtx(c, tx)
    const code = await tx.getCodeByHash(codeHash, true)
    if (!code) throw invalidCode()
    const again = await tx.getRedemption(code.id, installHash)
    if (!again) {
      if (
        !code.enabled || (code.valid_until && code.valid_until <= c.now) ||
        code.redeemed_count >= code.max_redemptions
      ) {
        throw invalidCode()
      }
      const entitlementId = crypto.randomUUID()
      await tx.insertEntitlement({
        id: entitlementId,
        subject_kind: 'install',
        subject_id: installId,
        plan: 'pro',
        source: code.kind,
        starts_at: c.now,
        ends_at: addDays(c.now, code.days),
        enabled: true,
        redeemed_code_id: code.id,
        team_id: null,
        store: null,
        note: null,
        created_at: c.now,
        created_by: null,
      })
      await tx.insertRedemption({
        id: crypto.randomUUID(),
        code_id: code.id,
        entitlement_id: entitlementId,
        install_id_hash: installHash,
        redeemed_at: c.now,
      })
      await tx.updateCode(code.id, { redeemed_count: code.redeemed_count + 1 })
    }
    return await signedOrNull(config, ctx, installId)
  })
}

export async function checkEntitlement(c: AppCall) {
  const { config, store, verifyToken } = c.deps
  if (!config.pepper) throw notConfigured('The code pepper')
  const installId = (c.body.install_id as string).toLowerCase()
  await rateLimit(store, c.now, [
    [`check:i:${await keyedHash(config.pepper, 'install', installId)}`, 60],
    [`check:ip:${await keyedHash(config.pepper, 'ip', c.ip)}`, 600],
  ])
  // store_receipt is ignored in this step (store billing is later) and is never logged.
  // A token that does not verify is treated as no token: the install's own entitlement still applies.
  const accountId = c.bearer ? await verifyToken(c.bearer) : null
  return await store.tx((tx) => signedOrNull(config, appCtx(c, tx), installId, accountId ?? undefined))
}

export function getPublicKeys(config: Config) {
  if (!config.publicKeys) throw notConfigured('The public keys')
  return config.publicKeys
}

export async function joinTeam(c: AppCall) {
  const { config, store, verifyToken } = c.deps
  if (!config.pepper) throw notConfigured('The code pepper')
  const accountId = c.bearer ? await verifyToken(c.bearer) : null
  if (!accountId) throw fail(401, 'SIGN_IN_REQUIRED', 'Sign in with SoHum to join a team.')
  await rateLimit(store, c.now, [
    [`join:a:${await keyedHash(config.pepper, 'install', accountId)}`, 20],
    [`join:ip:${await keyedHash(config.pepper, 'ip', c.ip)}`, 60],
  ])
  const code = (c.body.team_code as string).trim().toUpperCase()
  return await store.tx(async (tx) => {
    const team = await tx.getTeamByCode(code)
    if (!team) throw fail(404, 'TEAM_NOT_FOUND', 'No team has that code.')
    const existing = await tx.getMemberByAccount(team.team_id, accountId, true)
    if (existing?.status === 'removed') {
      // A removal sticks: the team code alone must not undo it.
      throw fail(409, 'REMOVED_FROM_TEAM', 'You were removed from this team. Ask the team manager.')
    }
    if (existing) return memberRecord(existing)
    const member = {
      id: crypto.randomUUID(),
      team_id: team.team_id,
      account_id: accountId,
      status: 'active' as const,
      joined_at: c.now,
      removed_at: null,
      removed_by: null,
    }
    await tx.insertMember(member)
    return memberRecord(member)
  })
}
