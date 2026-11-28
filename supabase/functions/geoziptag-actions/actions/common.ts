// Record builders (the contract's shapes), id masking, and the one rule for which entitlement the app is shown.
import type { Ctx } from '../context.ts'
import type { CodeRow, EntitlementRow, MemberRow, RedemptionRow, TeamPlanRow } from '../store.ts'
import type { Signable } from '../signing.ts'
import { fail, iso, mask } from '../util.ts'

export function entitlementRecord(e: EntitlementRow) {
  return {
    schema: 'sohum.geoziptag.entitlement/1',
    id: e.id,
    // Install and account ids are masked in every admin read. A team id is an organisation's, not a person's.
    subject: { kind: e.subject_kind, id: e.subject_kind === 'team' ? e.subject_id : mask(e.subject_id) },
    plan: e.plan,
    source: e.source,
    starts_at: iso(e.starts_at),
    ends_at: e.ends_at ? iso(e.ends_at) : null,
    enabled: e.enabled,
    ...(e.redeemed_code_id ? { redeemed_code_id: e.redeemed_code_id } : {}),
    ...(e.store ? { store: e.store } : {}),
    ...(e.note ? { note: e.note } : {}),
    created_at: iso(e.created_at),
    ...(e.created_by ? { created_by: e.created_by } : {}),
    ...(e.team_id ? { team_id: e.team_id } : {}),
  }
}

export function codeRecord(c: CodeRow) {
  return {
    schema: 'sohum.geoziptag.redeem_code/1',
    id: c.id,
    label: c.label,
    kind: c.kind,
    days: c.days,
    valid_until: c.valid_until ? iso(c.valid_until) : null,
    max_redemptions: c.max_redemptions,
    redeemed_count: c.redeemed_count,
    enabled: c.enabled,
    code_hint: c.code_hint,
    created_at: iso(c.created_at),
    ...(c.created_by ? { created_by: c.created_by } : {}),
  }
}

export function redemptionRecord(r: RedemptionRow & { install_id: string }) {
  return {
    schema: 'sohum.geoziptag.redemption/1',
    id: r.id,
    code_id: r.code_id,
    entitlement_id: r.entitlement_id,
    install_id_masked: mask(r.install_id),
    redeemed_at: iso(r.redeemed_at),
  }
}

/** Member counts under 10 are left out (console rule: aggregates hide small groups). */
export function teamPlanRecord(p: TeamPlanRow) {
  return {
    schema: 'sohum.geoziptag.team_plan/1',
    team_id: p.team_id,
    team_name: p.name,
    plan: p.plan,
    ...(p.entitlement_id ? { starts_at: iso(p.starts_at!), ends_at: p.ends_at ? iso(p.ends_at) : null } : {}),
    enabled: p.enabled,
    ...(p.member_count >= 10 ? { member_count: p.member_count } : {}),
    ...(p.entitlement_id ? { entitlement_id: p.entitlement_id } : {}),
  }
}

export function memberRecord(m: MemberRow) {
  return {
    schema: 'sohum.geoziptag.team_member/1',
    id: m.id,
    team_id: m.team_id,
    account_id_masked: mask(m.account_id),
    status: m.status,
    joined_at: iso(m.joined_at),
    ...(m.removed_at ? { removed_at: iso(m.removed_at) } : {}),
    ...(m.removed_by ? { removed_by: m.removed_by } : {}),
  }
}

export const isActive = (e: { enabled: boolean; starts_at: Date; ends_at: Date | null }, now: Date) =>
  e.enabled && e.starts_at <= now && (e.ends_at === null || e.ends_at > now)

const endsMs = (e: { ends_at: Date | null }) => (e.ends_at ? e.ends_at.getTime() : Infinity)

/** Of several active entitlements, the one that ends latest (no end date counts as latest). */
export function latestEnding<T extends { ends_at: Date | null }>(items: T[]): T | null {
  return items.reduce<T | null>((best, e) => (best === null || endsMs(e) > endsMs(best) ? e : best), null)
}

/** The team entitlement a signed-in member inherits: an active membership in a team whose plan is active and enabled. */
async function teamDerived(ctx: Ctx, accountId: string): Promise<Signable | null> {
  const derived: Signable[] = []
  for (const m of await ctx.tx.activeMembershipsForAccount(accountId)) {
    const plan = await ctx.tx.latestTeamEntitlement(m.team_id)
    if (plan && isActive(plan, ctx.now)) {
      derived.push({
        subject: { kind: 'account', id: accountId },
        source: 'team',
        starts_at: plan.starts_at,
        ends_at: plan.ends_at,
        enabled: true,
        team_id: m.team_id,
      })
    }
  }
  return latestEnding(derived)
}

/**
 * What the app is shown for an install (and, with a verified token, its account): the active entitlement that ends
 * latest, own or inherited. If nothing is active, the install's most recent one (so the app sees enabled:false or a
 * past ends_at). Null if it never had one.
 */
export async function resolveForInstall(
  ctx: Ctx,
  installId: string,
  accountId?: string,
): Promise<Signable | null> {
  const rows = await ctx.tx.entitlementsForSubject('install', installId)
  const own = latestEnding(rows.filter((e) => isActive(e, ctx.now)))
  const team = accountId ? await teamDerived(ctx, accountId) : null
  const candidates: Signable[] = []
  if (own) candidates.push(toSignable(own))
  if (team) candidates.push(team)
  const pick = latestEnding(candidates)
  if (pick) return pick
  const recent = [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0]
  return recent ? toSignable(recent) : null
}

export function toSignable(e: EntitlementRow): Signable {
  return {
    subject: { kind: e.subject_kind, id: e.subject_id },
    source: e.source,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    enabled: e.enabled,
    ...(e.team_id ? { team_id: e.team_id } : {}),
  }
}

export const notConfigured = (what: string) => fail(503, 'NOT_CONFIGURED', `${what} is not configured`)
