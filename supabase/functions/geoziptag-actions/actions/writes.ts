// The seven admin writes. Each has `check` (validate against the current state, return the human summary: used by
// propose and again inside confirm) and `apply` (the effect, run inside the confirm transaction).
import type { Ctx, Params } from '../context.ts'
import { deriveCode, formatCode } from '../codes.ts'
import { keyedHash } from '../signing.ts'
import { addDays, fail, iso, mask, UUID_RE } from '../util.ts'
import { codeRecord, entitlementRecord, memberRecord, notConfigured, teamPlanRecord } from './common.ts'

export interface WriteAction {
  check(ctx: Ctx, p: Params): Promise<string>
  /** The data stored against the idempotency key and returned by confirm. */
  apply(ctx: Ctx, p: Params, c: { proposalId: string }): Promise<unknown>
  /** Adds what must never be stored (the readable code) to a stored result before it is returned. */
  present?(data: unknown, c: { proposalId: string; pepper: string }): Promise<unknown>
}

const futureOrFail = (v: unknown, now: Date, what: string) => {
  if (v !== undefined && v !== null && new Date(v as string) <= now) {
    throw fail(422, 'IN_THE_PAST', `${what} must be in the future`)
  }
}

export const writes: Record<string, WriteAction> = {
  grant_entitlement: {
    // deno-lint-ignore require-await
    async check(ctx, p) {
      if (p.subject_kind === 'team') {
        throw fail(422, 'USE_CHANGE_TEAM_PLAN', 'Team plans are set with change_team_plan')
      }
      if (!UUID_RE.test(p.subject_id as string)) {
        throw fail(422, 'INVALID_SUBJECT', 'subject_id must be a uuid')
      }
      if ((p.days === undefined) === (p.ends_at === undefined)) {
        throw fail(422, 'NEEDS_ONE_OF_DAYS_OR_ENDS_AT', 'Give exactly one of days or ends_at')
      }
      futureOrFail(p.ends_at, ctx.now, 'ends_at')
      const until = p.ends_at ? new Date(p.ends_at as string) : addDays(ctx.now, p.days as number)
      return `Give Pro to ${p.subject_kind} ${mask(p.subject_id as string)} until ${
        iso(until)
      } (source ${p.source}).`
    },
    async apply(ctx, p) {
      const e = {
        id: crypto.randomUUID(),
        subject_kind: p.subject_kind as 'install' | 'account',
        subject_id: (p.subject_id as string).toLowerCase(),
        plan: 'pro' as const,
        source: p.source as 'paid' | 'admin',
        starts_at: ctx.now,
        ends_at: p.ends_at ? new Date(p.ends_at as string) : addDays(ctx.now, p.days as number),
        enabled: true,
        redeemed_code_id: null,
        team_id: null,
        store: null,
        note: (p.note as string | undefined) ?? null,
        created_at: ctx.now,
        created_by: ctx.actor,
      }
      await ctx.tx.insertEntitlement(e)
      return entitlementRecord(e)
    },
  },

  revoke_entitlement: {
    async check(ctx, p) {
      const e = await ctx.tx.getEntitlement(p.entitlement_id as string, false)
      if (!e) throw fail(404, 'NOT_FOUND', 'No such entitlement')
      return `End the ${e.source} entitlement of ${e.subject_kind} ${
        e.subject_kind === 'team' ? e.subject_id : mask(e.subject_id)
      } now. History is kept.`
    },
    async apply(ctx, p) {
      const e = await ctx.tx.getEntitlement(p.entitlement_id as string, true)
      if (!e) throw fail(404, 'NOT_FOUND', 'No such entitlement')
      const patch: { ends_at?: Date; note?: string | null } = {}
      if (e.ends_at === null || e.ends_at > ctx.now) {
        patch.ends_at = new Date(Math.max(ctx.now.getTime(), e.starts_at.getTime()))
      }
      if (p.note !== undefined) patch.note = p.note as string
      await ctx.tx.updateEntitlement(e.id, patch)
      return entitlementRecord((await ctx.tx.getEntitlement(e.id, false))!)
    },
  },

  set_entitlement_enabled: {
    async check(ctx, p) {
      const e = await ctx.tx.getEntitlement(p.entitlement_id as string, false)
      if (!e) throw fail(404, 'NOT_FOUND', 'No such entitlement')
      return `${p.enabled ? 'Re-enable' : 'Disable'} the ${e.source} entitlement of ${e.subject_kind} ${
        e.subject_kind === 'team' ? e.subject_id : mask(e.subject_id)
      }; dates are unchanged.`
    },
    async apply(ctx, p) {
      const e = await ctx.tx.getEntitlement(p.entitlement_id as string, true)
      if (!e) throw fail(404, 'NOT_FOUND', 'No such entitlement')
      const patch: { enabled: boolean; note?: string | null } = { enabled: p.enabled as boolean }
      if (p.note !== undefined) patch.note = p.note as string
      await ctx.tx.updateEntitlement(e.id, patch)
      return entitlementRecord((await ctx.tx.getEntitlement(e.id, false))!)
    },
  },

  create_redeem_code: {
    // deno-lint-ignore require-await
    async check(ctx, p) {
      if (!ctx.config.pepper) throw notConfigured('The code pepper')
      futureOrFail(p.valid_until, ctx.now, 'valid_until')
      return `Create a ${p.kind} code "${p.label}": ${p.days} days of Pro, up to ${p.max_redemptions} use${
        p.max_redemptions === 1 ? '' : 's'
      }, ${
        p.valid_until ? `redeemable until ${p.valid_until}` : 'no expiry'
      }. The readable code is shown once, after you confirm.`
    },
    async apply(ctx, p, { proposalId }) {
      const pepper = ctx.config.pepper!
      const code = await deriveCode(pepper, proposalId)
      const row = {
        id: crypto.randomUUID(),
        label: p.label as string,
        kind: p.kind as 'coupon' | 'trial',
        days: p.days as number,
        valid_until: p.valid_until ? new Date(p.valid_until as string) : null,
        max_redemptions: p.max_redemptions as number,
        redeemed_count: 0,
        enabled: true,
        code_hash: await keyedHash(pepper, 'code', code),
        code_hint: code.slice(-4),
        created_at: ctx.now,
        created_by: ctx.actor,
      }
      await ctx.tx.insertCode(row)
      // The readable code is not in the stored result: `present` adds it on the way out.
      return { schema: 'sohum.geoziptag.redeem_code.created/1', redeem_code: codeRecord(row) }
    },
    async present(data, { proposalId, pepper }) {
      const { schema, redeem_code } = data as { schema: string; redeem_code: unknown }
      return { schema, code: formatCode(await deriveCode(pepper, proposalId)), redeem_code }
    },
  },

  set_redeem_code_enabled: {
    async check(ctx, p) {
      const c = await ctx.tx.getCode(p.code_id as string, false)
      if (!c) throw fail(404, 'NOT_FOUND', 'No such code')
      return `${
        p.enabled ? 'Re-enable' : 'Disable'
      } the code "${c.label}" (…${c.code_hint}). Entitlements already given stay.`
    },
    async apply(ctx, p) {
      const c = await ctx.tx.getCode(p.code_id as string, true)
      if (!c) throw fail(404, 'NOT_FOUND', 'No such code')
      await ctx.tx.updateCode(c.id, { enabled: p.enabled as boolean })
      return codeRecord((await ctx.tx.getCode(c.id, false))!)
    },
  },

  change_team_plan: {
    async check(ctx, p) {
      const team = await ctx.tx.getTeamById(p.team_id as string)
      if (!team) throw fail(404, 'TEAM_NOT_FOUND', 'No such team in the register')
      if (p.plan === 'pro') futureOrFail(p.ends_at, ctx.now, 'ends_at')
      return p.plan === 'pro'
        ? `Put team "${team.name}" on Pro ${
          p.ends_at ? `until ${p.ends_at}` : 'with no end date'
        }. Signed-in members get it at their next check.`
        : `Put team "${team.name}" on the free plan now. Signed-in members lose Pro at their next check.`
    },
    async apply(ctx, p) {
      const teamId = p.team_id as string
      if (!(await ctx.tx.getTeamById(teamId))) {
        throw fail(404, 'TEAM_NOT_FOUND', 'No such team in the register')
      }
      if (p.plan === 'pro') {
        await ctx.tx.insertEntitlement({
          id: crypto.randomUUID(),
          subject_kind: 'team',
          subject_id: teamId,
          plan: 'pro',
          source: 'admin',
          starts_at: ctx.now,
          ends_at: p.ends_at ? new Date(p.ends_at as string) : null,
          enabled: true,
          redeemed_code_id: null,
          team_id: teamId,
          store: null,
          note: null,
          created_at: ctx.now,
          created_by: ctx.actor,
        })
      } else {
        const current = await ctx.tx.latestTeamEntitlement(teamId)
        if (current && (current.ends_at === null || current.ends_at > ctx.now)) {
          await ctx.tx.updateEntitlement(current.id, {
            ends_at: new Date(Math.max(ctx.now.getTime(), current.starts_at.getTime())),
          })
        }
      }
      return teamPlanRecord((await ctx.tx.teamPlan(teamId, ctx.now))!)
    },
  },

  remove_team_member: {
    async check(ctx, p) {
      const m = await ctx.tx.getMember(p.membership_id as string, false)
      if (!m) throw fail(404, 'NOT_FOUND', 'No such membership')
      return `Remove member ${
        mask(m.account_id)
      } from team ${m.team_id}. Their Pro from the team ends at their next check.`
    },
    async apply(ctx, p) {
      const m = await ctx.tx.getMember(p.membership_id as string, true)
      if (!m) throw fail(404, 'NOT_FOUND', 'No such membership')
      if (m.status === 'active') {
        await ctx.tx.updateMember(m.id, { status: 'removed', removed_at: ctx.now, removed_by: ctx.actor })
      }
      return memberRecord((await ctx.tx.getMember(m.id, false))!)
    },
  },
}
