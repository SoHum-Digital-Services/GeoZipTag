// The database interface. Every action talks to this, never to SQL. pg_store.ts is the Postgres implementation
// (parameterised SQL only); tests/memory_store.ts is an in-memory implementation of the same interface.
import type { Source, SubjectKind } from './signing.ts'

export interface EntitlementRow {
  id: string
  subject_kind: SubjectKind
  subject_id: string
  plan: 'pro'
  source: Source
  starts_at: Date
  ends_at: Date | null
  enabled: boolean
  redeemed_code_id: string | null
  team_id: string | null
  store: { platform: string; product_id: string } | null
  note: string | null
  created_at: Date
  created_by: string | null
}

export interface CodeRow {
  id: string
  label: string
  kind: 'coupon' | 'trial'
  days: number
  valid_until: Date | null
  max_redemptions: number
  redeemed_count: number
  enabled: boolean
  code_hash: string
  code_hint: string
  created_at: Date
  created_by: string | null
}

export interface RedemptionRow {
  id: string
  code_id: string
  entitlement_id: string
  install_id_hash: string
  redeemed_at: Date
}

export interface MemberRow {
  id: string
  team_id: string
  account_id: string
  status: 'active' | 'removed'
  joined_at: Date
  removed_at: Date | null
  removed_by: string | null
}

export interface ProposalRow {
  id: string
  action: string
  actor: string
  params: Record<string, unknown>
  created_at: Date
  expires_at: Date
  confirmed_key: string | null
  result: unknown | null
}

export interface AuditRow {
  request_id: string
  actor: string
  role: string
  action: string
  phase: string
  outcome: string
  at: Date
  detail: Record<string, unknown> | null
}

/** A team in the existing shared register (public.geoziptag_teams): read only. */
export interface TeamRow {
  team_id: string
  name: string
}

export interface TeamPlanRow extends TeamRow {
  plan: 'free' | 'pro'
  entitlement_id: string | null
  starts_at: Date | null
  ends_at: Date | null
  enabled: boolean
  member_count: number
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export interface PageArgs {
  limit: number
  cursor?: string
}

export interface Tx {
  // replay window, rate limits
  /** Records the request id; returns false if it was already seen inside the window (a replay). */
  claimRequestId(id: string, now: Date): Promise<boolean>
  /** Adds one to the bucket's counter for this window and returns the new count. */
  bump(bucket: string, windowStart: Date): Promise<number>
  /** Housekeeping: drop request ids and counters older than the cut-off. */
  prune(before: Date): Promise<void>

  // proposals, idempotency, audit
  insertProposal(p: ProposalRow): Promise<void>
  getProposal(id: string, lock: boolean): Promise<ProposalRow | null>
  markConfirmed(id: string, key: string, result: unknown): Promise<void>
  getIdempotency(key: string, action: string): Promise<unknown | null>
  putIdempotency(key: string, action: string, result: unknown, now: Date): Promise<void>
  audit(row: AuditRow): Promise<void>

  // entitlements
  insertEntitlement(e: EntitlementRow): Promise<void>
  getEntitlement(id: string, lock: boolean): Promise<EntitlementRow | null>
  updateEntitlement(
    id: string,
    patch: Partial<Pick<EntitlementRow, 'enabled' | 'ends_at' | 'note'>>,
  ): Promise<void>
  /** All rows for one subject (small: a handful per install). */
  entitlementsForSubject(kind: SubjectKind, id: string): Promise<EntitlementRow[]>
  /** The team's current plan row: the latest (created_at, id) row with subject_kind team. */
  latestTeamEntitlement(teamId: string): Promise<EntitlementRow | null>
  listEntitlements(
    f: { subject_kind?: string; subject_id?: string; source?: string; enabled?: boolean; active_at?: Date },
    page: PageArgs,
  ): Promise<Page<EntitlementRow>>

  // redeem codes and redemptions
  insertCode(c: CodeRow): Promise<void>
  getCode(id: string, lock: boolean): Promise<CodeRow | null>
  getCodeByHash(hash: string, lock: boolean): Promise<CodeRow | null>
  updateCode(id: string, patch: Partial<Pick<CodeRow, 'enabled' | 'redeemed_count'>>): Promise<void>
  listCodes(f: { enabled?: boolean; kind?: string }, page: PageArgs): Promise<Page<CodeRow>>
  getRedemption(codeId: string, installHash: string): Promise<RedemptionRow | null>
  insertRedemption(r: RedemptionRow): Promise<void>
  /** The log, with each row's install id taken from its entitlement (masked by the caller). */
  listRedemptions(
    f: { code_id?: string; from?: Date; to?: Date },
    page: PageArgs,
  ): Promise<Page<RedemptionRow & { install_id: string }>>

  // teams (the register is read only) and memberships
  getTeamById(teamId: string): Promise<TeamRow | null>
  getTeamByCode(code: string): Promise<TeamRow | null>
  listTeamPlans(f: { plan?: 'free' | 'pro' }, page: PageArgs, now: Date): Promise<Page<TeamPlanRow>>
  teamPlan(teamId: string, now: Date): Promise<TeamPlanRow | null>
  getMember(id: string, lock: boolean): Promise<MemberRow | null>
  getMemberByAccount(teamId: string, accountId: string, lock: boolean): Promise<MemberRow | null>
  insertMember(m: MemberRow): Promise<void>
  updateMember(
    id: string,
    patch: Partial<Pick<MemberRow, 'status' | 'removed_at' | 'removed_by'>>,
  ): Promise<void>
  activeMembershipsForAccount(accountId: string): Promise<MemberRow[]>
  listMembers(f: { team_id: string; status?: string }, page: PageArgs): Promise<Page<MemberRow>>
}

export interface Store {
  /** Runs fn in one transaction: all of its writes commit together or none do. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

export function encodeCursor(parts: unknown[]): string {
  return btoa(JSON.stringify(parts)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCursor(cursor: string | undefined): unknown[] | null {
  if (!cursor) return null
  try {
    const std = cursor.replace(/-/g, '+').replace(/_/g, '/')
    const v = JSON.parse(atob(std + '='.repeat((4 - (std.length % 4)) % 4)))
    if (Array.isArray(v) && v.length >= 1 && v.length <= 3) return v
  } catch { /* fall through */ }
  throw new CursorError()
}

export class CursorError extends Error {
  constructor() {
    super('Invalid cursor')
  }
}
