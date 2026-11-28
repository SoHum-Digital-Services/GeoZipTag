// In-memory implementation of the Store interface, for tests. A transaction takes a mutex (so two "simultaneous"
// redemptions serialise, like a row lock) and rolls back to a snapshot if it throws.
import {
  type AuditRow,
  type CodeRow,
  decodeCursor,
  encodeCursor,
  type EntitlementRow,
  type MemberRow,
  type Page,
  type PageArgs,
  type ProposalRow,
  type RedemptionRow,
  type Store,
  type TeamPlanRow,
  type TeamRow,
  type Tx,
} from '../store.ts'

export interface MemoryState {
  entitlements: EntitlementRow[]
  codes: CodeRow[]
  redemptions: RedemptionRow[]
  members: MemberRow[]
  proposals: ProposalRow[]
  idempotency: Map<string, unknown>
  requestIds: Map<string, Date>
  counters: Map<string, number>
  audit: AuditRow[]
  teams: (TeamRow & { code: string })[]
}

export const emptyState = (): MemoryState => ({
  entitlements: [],
  codes: [],
  redemptions: [],
  members: [],
  proposals: [],
  idempotency: new Map(),
  requestIds: new Map(),
  counters: new Map(),
  audit: [],
  teams: [],
})

const clone = <T>(v: T): T => structuredClone(v)
const WINDOW_MS = 600_000

function page<T>(rows: T[], args: PageArgs, key: (r: T) => unknown[]): Page<T> {
  const items = rows.slice(0, args.limit)
  const more = rows.length > args.limit
  return { items, next_cursor: more ? encodeCursor(key(items[items.length - 1]).map(String)) : null }
}

/** newest first by (created_at, id) */
const newestFirst = <T extends { id: string }>(rows: T[], at: (r: T) => Date, cursor: unknown[] | null) => {
  const sorted = [...rows].sort((a, b) =>
    at(b).getTime() - at(a).getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  )
  if (!cursor) return sorted
  const [t, id] = cursor as [string, string]
  const ms = Date.parse(t)
  return sorted.filter((r) => at(r).getTime() < ms || (at(r).getTime() === ms && r.id < id))
}

class MemTx implements Tx {
  constructor(public s: MemoryState) {}

  claimRequestId(id: string, now: Date) {
    if (this.s.requestIds.has(id)) return Promise.resolve(false)
    this.s.requestIds.set(id, now)
    return Promise.resolve(true)
  }
  bump(bucket: string, windowStart: Date) {
    const k = `${bucket}@${windowStart.toISOString()}`
    const n = (this.s.counters.get(k) ?? 0) + 1
    this.s.counters.set(k, n)
    return Promise.resolve(n)
  }
  prune(before: Date) {
    for (const [k, v] of this.s.requestIds) if (v < before) this.s.requestIds.delete(k)
    return Promise.resolve()
  }

  insertProposal(p: ProposalRow) {
    this.s.proposals.push(clone(p))
    return Promise.resolve()
  }
  getProposal(id: string) {
    const p = this.s.proposals.find((x) => x.id === id)
    return Promise.resolve(p ? clone(p) : null)
  }
  markConfirmed(id: string, key: string, result: unknown) {
    const p = this.s.proposals.find((x) => x.id === id)!
    p.confirmed_key = key
    p.result = clone(result)
    return Promise.resolve()
  }
  getIdempotency(key: string, action: string) {
    const v = this.s.idempotency.get(`${key}|${action}`)
    return Promise.resolve(v === undefined ? null : clone(v))
  }
  putIdempotency(key: string, action: string, result: unknown) {
    this.s.idempotency.set(`${key}|${action}`, clone(result))
    return Promise.resolve()
  }
  audit(row: AuditRow) {
    this.s.audit.push(clone(row))
    return Promise.resolve()
  }

  insertEntitlement(e: EntitlementRow) {
    this.s.entitlements.push(clone(e))
    return Promise.resolve()
  }
  getEntitlement(id: string) {
    const e = this.s.entitlements.find((x) => x.id === id)
    return Promise.resolve(e ? clone(e) : null)
  }
  updateEntitlement(id: string, patch: Partial<EntitlementRow>) {
    Object.assign(this.s.entitlements.find((x) => x.id === id)!, clone(patch))
    return Promise.resolve()
  }
  entitlementsForSubject(kind: string, id: string) {
    return Promise.resolve(
      this.s.entitlements.filter((e) => e.subject_kind === kind && e.subject_id === id).map(clone),
    )
  }
  latestTeamEntitlement(teamId: string) {
    const rows = newestFirst(
      this.s.entitlements.filter((e) => e.subject_kind === 'team' && e.subject_id === teamId),
      (r) => r.created_at,
      null,
    )
    return Promise.resolve(rows[0] ? clone(rows[0]) : null)
  }
  listEntitlements(
    f: { subject_kind?: string; subject_id?: string; source?: string; enabled?: boolean; active_at?: Date },
    args: PageArgs,
  ) {
    let rows = this.s.entitlements.filter((e) =>
      (f.subject_kind === undefined || e.subject_kind === f.subject_kind) &&
      (f.subject_id === undefined || e.subject_id === f.subject_id) &&
      (f.source === undefined || e.source === f.source) &&
      (f.enabled === undefined || e.enabled === f.enabled) &&
      (f.active_at === undefined ||
        (e.starts_at <= f.active_at && (e.ends_at === null || e.ends_at > f.active_at)))
    )
    rows = newestFirst(rows, (r) => r.created_at, decodeCursor(args.cursor))
    const p = page(rows.slice(0, args.limit + 1), args, (r) => [r.created_at.toISOString(), r.id])
    return Promise.resolve({ ...p, items: p.items.map(clone) })
  }

  insertCode(c: CodeRow) {
    if (this.s.codes.some((x) => x.code_hash === c.code_hash)) throw new Error('duplicate code_hash')
    this.s.codes.push(clone(c))
    return Promise.resolve()
  }
  getCode(id: string) {
    const c = this.s.codes.find((x) => x.id === id)
    return Promise.resolve(c ? clone(c) : null)
  }
  getCodeByHash(hash: string) {
    const c = this.s.codes.find((x) => x.code_hash === hash)
    return Promise.resolve(c ? clone(c) : null)
  }
  updateCode(id: string, patch: Partial<CodeRow>) {
    Object.assign(this.s.codes.find((x) => x.id === id)!, patch)
    return Promise.resolve()
  }
  listCodes(f: { enabled?: boolean; kind?: string }, args: PageArgs) {
    let rows = this.s.codes.filter((c) =>
      (f.enabled === undefined || c.enabled === f.enabled) && (f.kind === undefined || c.kind === f.kind)
    )
    rows = newestFirst(rows, (r) => r.created_at, decodeCursor(args.cursor))
    const p = page(rows.slice(0, args.limit + 1), args, (r) => [r.created_at.toISOString(), r.id])
    return Promise.resolve({ ...p, items: p.items.map(clone) })
  }
  getRedemption(codeId: string, installHash: string) {
    const r = this.s.redemptions.find((x) => x.code_id === codeId && x.install_id_hash === installHash)
    return Promise.resolve(r ? clone(r) : null)
  }
  insertRedemption(r: RedemptionRow) {
    if (this.s.redemptions.some((x) => x.code_id === r.code_id && x.install_id_hash === r.install_id_hash)) {
      throw new Error('duplicate redemption')
    }
    this.s.redemptions.push(clone(r))
    return Promise.resolve()
  }
  listRedemptions(f: { code_id?: string; from?: Date; to?: Date }, args: PageArgs) {
    let rows = this.s.redemptions.filter((r) =>
      (f.code_id === undefined || r.code_id === f.code_id) &&
      (f.from === undefined || r.redeemed_at >= f.from) &&
      (f.to === undefined || r.redeemed_at <= f.to)
    )
    rows = newestFirst(rows, (r) => r.redeemed_at, decodeCursor(args.cursor))
    const p = page(rows.slice(0, args.limit + 1), args, (r) => [r.redeemed_at.toISOString(), r.id])
    return Promise.resolve({
      ...p,
      items: p.items.map((r) => ({
        ...clone(r),
        install_id: this.s.entitlements.find((e) => e.id === r.entitlement_id)!.subject_id,
      })),
    })
  }

  getTeamById(teamId: string) {
    const t = this.s.teams.find((x) => x.team_id === teamId)
    return Promise.resolve(t ? { team_id: t.team_id, name: t.name } : null)
  }
  getTeamByCode(code: string) {
    const t = this.s.teams.find((x) => x.code === code)
    return Promise.resolve(t ? { team_id: t.team_id, name: t.name } : null)
  }
  private planOf(t: TeamRow, now: Date): TeamPlanRow {
    const row =
      [...this.s.entitlements.filter((e) => e.subject_kind === 'team' && e.subject_id === t.team_id)]
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1))[0]
    const pro = !!row && row.enabled && row.starts_at <= now && (row.ends_at === null || row.ends_at > now)
    return {
      team_id: t.team_id,
      name: t.name,
      plan: pro ? 'pro' : 'free',
      entitlement_id: row?.id ?? null,
      starts_at: row?.starts_at ?? null,
      ends_at: row?.ends_at ?? null,
      enabled: pro,
      member_count: this.s.members.filter((m) => m.team_id === t.team_id && m.status === 'active').length,
    }
  }
  teamPlan(teamId: string, now: Date) {
    const t = this.s.teams.find((x) => x.team_id === teamId)
    return Promise.resolve(t ? this.planOf(t, now) : null)
  }
  listTeamPlans(f: { plan?: 'free' | 'pro' }, args: PageArgs, now: Date) {
    const after = decodeCursor(args.cursor)?.[0] as string | undefined
    const rows = [...this.s.teams].sort((a, b) => (a.team_id < b.team_id ? -1 : 1))
      .filter((t) => after === undefined || t.team_id > after)
      .map((t) => this.planOf(t, now))
      .filter((p) => f.plan === undefined || p.plan === f.plan)
    const items = rows.slice(0, args.limit)
    return Promise.resolve({
      items,
      next_cursor: rows.length > args.limit ? encodeCursor([items[items.length - 1].team_id]) : null,
    })
  }
  getMember(id: string) {
    const m = this.s.members.find((x) => x.id === id)
    return Promise.resolve(m ? clone(m) : null)
  }
  getMemberByAccount(teamId: string, accountId: string) {
    const m = this.s.members.find((x) => x.team_id === teamId && x.account_id === accountId)
    return Promise.resolve(m ? clone(m) : null)
  }
  insertMember(m: MemberRow) {
    if (this.s.members.some((x) => x.team_id === m.team_id && x.account_id === m.account_id)) {
      throw new Error('duplicate member')
    }
    this.s.members.push(clone(m))
    return Promise.resolve()
  }
  updateMember(id: string, patch: Partial<MemberRow>) {
    Object.assign(this.s.members.find((x) => x.id === id)!, patch)
    return Promise.resolve()
  }
  activeMembershipsForAccount(accountId: string) {
    return Promise.resolve(
      this.s.members.filter((m) => m.account_id === accountId && m.status === 'active').map(clone),
    )
  }
  listMembers(f: { team_id: string; status?: string }, args: PageArgs) {
    let rows = this.s.members.filter((m) =>
      m.team_id === f.team_id && (f.status === undefined || m.status === f.status)
    )
    rows = newestFirst(rows, (r) => r.joined_at, decodeCursor(args.cursor))
    const p = page(rows.slice(0, args.limit + 1), args, (r) => [r.joined_at.toISOString(), r.id])
    return Promise.resolve({ ...p, items: p.items.map(clone) })
  }
}

export class MemoryStore implements Store {
  state = emptyState()
  private chain: Promise<unknown> = Promise.resolve()
  windowMs = WINDOW_MS

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async () => {
      const snapshot = structuredClone(this.state)
      try {
        return await fn(new MemTx(this.state))
      } catch (e) {
        this.state = snapshot
        throw e
      }
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }

  /** Row counts of the domain tables, for "nothing changed" assertions. */
  counts() {
    const s = this.state
    return {
      entitlements: s.entitlements.length,
      codes: s.codes.length,
      redemptions: s.redemptions.length,
      members: s.members.length,
    }
  }
}
