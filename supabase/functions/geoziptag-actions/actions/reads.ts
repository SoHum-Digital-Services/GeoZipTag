// The six admin reads. Params arrive already validated against the manifest's params_schema.
import type { Ctx, Params } from '../context.ts'
import type { Page } from '../store.ts'
import { fail } from '../util.ts'
import { codeRecord, entitlementRecord, memberRecord, redemptionRecord, teamPlanRecord } from './common.ts'

export type ReadAction = (ctx: Ctx, p: Params) => Promise<unknown>

const paged = <T, R>(page: Page<T>, map: (t: T) => R) => ({
  items: page.items.map(map),
  next_cursor: page.next_cursor,
})
const args = (p: Params) => ({ limit: p.limit as number, cursor: p.cursor as string | undefined })
const date = (v: unknown) => (v === undefined ? undefined : new Date(v as string))

export const reads: Record<string, ReadAction> = {
  async list_entitlements(ctx, p) {
    return paged(
      await ctx.tx.listEntitlements({
        subject_kind: p.subject_kind as string | undefined,
        subject_id: p.subject_id as string | undefined,
        source: p.source as string | undefined,
        enabled: p.enabled as boolean | undefined,
        active_at: date(p.active_at),
      }, args(p)),
      entitlementRecord,
    )
  },
  async get_entitlement(ctx, p) {
    const e = await ctx.tx.getEntitlement(p.entitlement_id as string, false)
    if (!e) throw fail(404, 'NOT_FOUND', 'No such entitlement')
    return entitlementRecord(e)
  },
  async list_redeem_codes(ctx, p) {
    return paged(
      await ctx.tx.listCodes({
        enabled: p.enabled as boolean | undefined,
        kind: p.kind as string | undefined,
      }, args(p)),
      codeRecord,
    )
  },
  async list_redemptions(ctx, p) {
    return paged(
      await ctx.tx.listRedemptions(
        { code_id: p.code_id as string | undefined, from: date(p.from), to: date(p.to) },
        args(p),
      ),
      redemptionRecord,
    )
  },
  async list_team_plans(ctx, p) {
    return paged(
      await ctx.tx.listTeamPlans({ plan: p.plan as 'free' | 'pro' | undefined }, args(p), ctx.now),
      teamPlanRecord,
    )
  },
  async list_team_members(ctx, p) {
    return paged(
      await ctx.tx.listMembers(
        { team_id: p.team_id as string, status: p.status as string | undefined },
        args(p),
      ),
      memberRecord,
    )
  },
}
