// Postgres implementation of the Store. Parameterised SQL only (the `postgres` tagged template sends every
// interpolated value as a bind parameter; nothing here builds SQL from strings). Reached through SUPABASE_DB_URL,
// so the geoziptag schema is never exposed through the REST API.
import postgres from 'postgres'
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
} from './store.ts'

type Row = Record<string, unknown>
type Q = postgres.Sql | postgres.TransactionSql

const lock = (l: boolean, q: Q) => (l ? q`for update` : q``)

function pageOf<T>(rows: T[], args: PageArgs, cursorOf: (r: T) => unknown[]): Page<T> {
  const items = rows.slice(0, args.limit)
  return {
    items,
    next_cursor: rows.length > args.limit ? encodeCursor(cursorOf(items[items.length - 1])) : null,
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))

class PgTx implements Tx {
  constructor(private q: Q) {}

  async claimRequestId(id: string, now: Date) {
    const r = await this.q`insert into geoziptag.request_log (request_id, seen_at) values (${id}, ${now})
      on conflict (request_id) do nothing returning request_id`
    return r.length === 1
  }
  async bump(bucket: string, windowStart: Date) {
    const r = await this.q`insert into geoziptag.rate_counters (bucket, window_start, count)
      values (${bucket}, ${windowStart}, 1)
      on conflict (bucket, window_start) do update set count = geoziptag.rate_counters.count + 1
      returning count`
    return Number(r[0].count)
  }
  async prune(before: Date) {
    await this.q`delete from geoziptag.request_log where seen_at < ${before}`
    await this.q`delete from geoziptag.rate_counters where window_start < ${before}`
  }

  async insertProposal(p: ProposalRow) {
    await this.q`insert into geoziptag.proposals (id, action, actor, params, created_at, expires_at)
      values (${p.id}, ${p.action}, ${p.actor}, ${
      this.q.json(p.params as postgres.JSONValue)
    }, ${p.created_at}, ${p.expires_at})`
  }
  async getProposal(id: string, l: boolean) {
    const r = await this.q`select * from geoziptag.proposals where id = ${id} ${lock(l, this.q)}`
    return (r[0] as unknown as ProposalRow) ?? null
  }
  async markConfirmed(id: string, key: string, result: unknown) {
    await this.q`update geoziptag.proposals set confirmed_key = ${key}, result = ${
      this.q.json(result as postgres.JSONValue)
    } where id = ${id}`
  }
  async getIdempotency(key: string, action: string) {
    const r = await this.q`select result from geoziptag.idempotency where key = ${key} and action = ${action}`
    return r[0]?.result ?? null
  }
  async putIdempotency(key: string, action: string, result: unknown, now: Date) {
    await this.q`insert into geoziptag.idempotency (key, action, result, created_at)
      values (${key}, ${action}, ${this.q.json(result as postgres.JSONValue)}, ${now})`
  }
  async audit(a: AuditRow) {
    await this.q`insert into geoziptag.audit (request_id, actor, role, action, phase, outcome, at, detail)
      values (${a.request_id}, ${a.actor}, ${a.role}, ${a.action}, ${a.phase}, ${a.outcome}, ${a.at},
        ${a.detail ? this.q.json(a.detail as postgres.JSONValue) : null})`
  }

  async insertEntitlement(e: EntitlementRow) {
    await this.q`insert into geoziptag.entitlements
      (id, subject_kind, subject_id, plan, source, starts_at, ends_at, enabled, redeemed_code_id, team_id, store, note, created_at, created_by)
      values (${e.id}, ${e.subject_kind}, ${e.subject_id}, ${e.plan}, ${e.source}, ${e.starts_at}, ${e.ends_at}, ${e.enabled},
        ${e.redeemed_code_id}, ${e.team_id}, ${
      e.store ? this.q.json(e.store) : null
    }, ${e.note}, ${e.created_at}, ${e.created_by})`
  }
  async getEntitlement(id: string, l: boolean) {
    const r = await this.q`select * from geoziptag.entitlements where id = ${id} ${lock(l, this.q)}`
    return (r[0] as unknown as EntitlementRow) ?? null
  }
  async updateEntitlement(id: string, patch: Partial<Pick<EntitlementRow, 'enabled' | 'ends_at' | 'note'>>) {
    // Only the three patchable columns, each through its own bind parameter.
    await this.q`update geoziptag.entitlements set
        enabled = coalesce(${patch.enabled ?? null}, enabled),
        ends_at = case when ${'ends_at' in patch} then ${patch.ends_at ?? null}::timestamptz else ends_at end,
        note = case when ${'note' in patch} then ${patch.note ?? null} else note end
      where id = ${id}`
  }
  async entitlementsForSubject(kind: string, id: string) {
    const r = await this
      .q`select * from geoziptag.entitlements where subject_kind = ${kind} and subject_id = ${id}`
    return r as unknown as EntitlementRow[]
  }
  async latestTeamEntitlement(teamId: string) {
    const r = await this
      .q`select * from geoziptag.entitlements where subject_kind = 'team' and subject_id = ${teamId}
      order by created_at desc, id desc limit 1`
    return (r[0] as unknown as EntitlementRow) ?? null
  }
  async listEntitlements(
    f: { subject_kind?: string; subject_id?: string; source?: string; enabled?: boolean; active_at?: Date },
    args: PageArgs,
  ) {
    const c = decodeCursor(args.cursor) as [string, string] | null
    const q = this.q
    const rows = await q`select * from geoziptag.entitlements where true
      ${f.subject_kind !== undefined ? q`and subject_kind = ${f.subject_kind}` : q``}
      ${f.subject_id !== undefined ? q`and subject_id = ${f.subject_id}` : q``}
      ${f.source !== undefined ? q`and source = ${f.source}` : q``}
      ${f.enabled !== undefined ? q`and enabled = ${f.enabled}` : q``}
      ${
      f.active_at !== undefined
        ? q`and starts_at <= ${f.active_at} and (ends_at is null or ends_at > ${f.active_at})`
        : q``
    }
      ${c ? q`and (created_at, id) < (${new Date(c[0])}, ${c[1]}::uuid)` : q``}
      order by created_at desc, id desc limit ${args.limit + 1}`
    return pageOf(rows as unknown as EntitlementRow[], args, (r) => [iso(r.created_at), r.id])
  }

  async insertCode(c: CodeRow) {
    await this.q`insert into geoziptag.redeem_codes
      (id, label, kind, days, valid_until, max_redemptions, redeemed_count, enabled, code_hash, code_hint, created_at, created_by)
      values (${c.id}, ${c.label}, ${c.kind}, ${c.days}, ${c.valid_until}, ${c.max_redemptions}, ${c.redeemed_count},
        ${c.enabled}, ${c.code_hash}, ${c.code_hint}, ${c.created_at}, ${c.created_by})`
  }
  async getCode(id: string, l: boolean) {
    const r = await this.q`select * from geoziptag.redeem_codes where id = ${id} ${lock(l, this.q)}`
    return (r[0] as unknown as CodeRow) ?? null
  }
  async getCodeByHash(hash: string, l: boolean) {
    const r = await this.q`select * from geoziptag.redeem_codes where code_hash = ${hash} ${lock(l, this.q)}`
    return (r[0] as unknown as CodeRow) ?? null
  }
  async updateCode(id: string, patch: Partial<Pick<CodeRow, 'enabled' | 'redeemed_count'>>) {
    await this.q`update geoziptag.redeem_codes set
        enabled = coalesce(${patch.enabled ?? null}, enabled),
        redeemed_count = coalesce(${patch.redeemed_count ?? null}, redeemed_count)
      where id = ${id}`
  }
  async listCodes(f: { enabled?: boolean; kind?: string }, args: PageArgs) {
    const c = decodeCursor(args.cursor) as [string, string] | null
    const q = this.q
    const rows = await q`select * from geoziptag.redeem_codes where true
      ${f.enabled !== undefined ? q`and enabled = ${f.enabled}` : q``}
      ${f.kind !== undefined ? q`and kind = ${f.kind}` : q``}
      ${c ? q`and (created_at, id) < (${new Date(c[0])}, ${c[1]}::uuid)` : q``}
      order by created_at desc, id desc limit ${args.limit + 1}`
    return pageOf(rows as unknown as CodeRow[], args, (r) => [iso(r.created_at), r.id])
  }
  async getRedemption(codeId: string, installHash: string) {
    const r = await this
      .q`select * from geoziptag.redemptions where code_id = ${codeId} and install_id_hash = ${installHash}`
    return (r[0] as unknown as RedemptionRow) ?? null
  }
  async insertRedemption(r: RedemptionRow) {
    await this.q`insert into geoziptag.redemptions (id, code_id, entitlement_id, install_id_hash, redeemed_at)
      values (${r.id}, ${r.code_id}, ${r.entitlement_id}, ${r.install_id_hash}, ${r.redeemed_at})`
  }
  async listRedemptions(f: { code_id?: string; from?: Date; to?: Date }, args: PageArgs) {
    const c = decodeCursor(args.cursor) as [string, string] | null
    const q = this.q
    const rows = await q`select r.*, e.subject_id as install_id
      from geoziptag.redemptions r join geoziptag.entitlements e on e.id = r.entitlement_id where true
      ${f.code_id !== undefined ? q`and r.code_id = ${f.code_id}::uuid` : q``}
      ${f.from !== undefined ? q`and r.redeemed_at >= ${f.from}` : q``}
      ${f.to !== undefined ? q`and r.redeemed_at <= ${f.to}` : q``}
      ${c ? q`and (r.redeemed_at, r.id) < (${new Date(c[0])}, ${c[1]}::uuid)` : q``}
      order by r.redeemed_at desc, r.id desc limit ${args.limit + 1}`
    return pageOf(
      rows as unknown as (RedemptionRow & { install_id: string })[],
      args,
      (r) => [iso(r.redeemed_at), r.id],
    )
  }

  // The register's real columns are not in this repository. ASSUMED (see QUESTIONS.md): public.geoziptag_teams has
  // `id` (any type, compared as text), `name` and `code` (the join code). Read only. Isolated here so a different
  // column name is a one-line change.
  async getTeamById(teamId: string) {
    const r = await this
      .q`select id::text as team_id, name from public.geoziptag_teams where id::text = ${teamId}`
    return (r[0] as unknown as TeamRow) ?? null
  }
  async getTeamByCode(code: string) {
    const r = await this
      .q`select id::text as team_id, name from public.geoziptag_teams where upper(code) = ${code}`
    return (r[0] as unknown as TeamRow) ?? null
  }
  private teamPlans(f: { plan?: 'free' | 'pro'; teamId?: string; after?: string }, limit: number, now: Date) {
    const q = this.q
    return q`select * from (
        select t.id::text as team_id, t.name, l.id as entitlement_id, l.starts_at, l.ends_at,
          coalesce(l.enabled and l.starts_at <= ${now} and (l.ends_at is null or l.ends_at > ${now}), false) as pro,
          (select count(*)::int from geoziptag.team_members m where m.team_id = t.id::text and m.status = 'active') as member_count
        from public.geoziptag_teams t
        left join lateral (
          select * from geoziptag.entitlements e where e.subject_kind = 'team' and e.subject_id = t.id::text
          order by e.created_at desc, e.id desc limit 1
        ) l on true
        where true
        ${f.teamId !== undefined ? q`and t.id::text = ${f.teamId}` : q``}
        ${f.after !== undefined ? q`and t.id::text collate "C" > ${f.after} collate "C"` : q``}
      ) x
      where true ${f.plan === 'pro' ? q`and pro` : q``} ${f.plan === 'free' ? q`and not pro` : q``}
      order by team_id collate "C" limit ${limit}`
  }
  private toPlan(r: Row): TeamPlanRow {
    return {
      team_id: r.team_id as string,
      name: r.name as string,
      plan: r.pro ? 'pro' : 'free',
      entitlement_id: (r.entitlement_id as string) ?? null,
      starts_at: (r.starts_at as Date) ?? null,
      ends_at: (r.ends_at as Date) ?? null,
      enabled: Boolean(r.pro),
      member_count: Number(r.member_count),
    }
  }
  async teamPlan(teamId: string, now: Date) {
    const r = await this.teamPlans({ teamId }, 1, now)
    return r[0] ? this.toPlan(r[0]) : null
  }
  async listTeamPlans(f: { plan?: 'free' | 'pro' }, args: PageArgs, now: Date) {
    const after = decodeCursor(args.cursor)?.[0] as string | undefined
    const rows = (await this.teamPlans({ plan: f.plan, after }, args.limit + 1, now)).map((r) =>
      this.toPlan(r)
    )
    const items = rows.slice(0, args.limit)
    return {
      items,
      next_cursor: rows.length > args.limit ? encodeCursor([items[items.length - 1].team_id]) : null,
    }
  }
  async getMember(id: string, l: boolean) {
    const r = await this.q`select * from geoziptag.team_members where id = ${id} ${lock(l, this.q)}`
    return (r[0] as unknown as MemberRow) ?? null
  }
  async getMemberByAccount(teamId: string, accountId: string, l: boolean) {
    const r = await this
      .q`select * from geoziptag.team_members where team_id = ${teamId} and account_id = ${accountId}::uuid ${
      lock(l, this.q)
    }`
    return (r[0] as unknown as MemberRow) ?? null
  }
  async insertMember(m: MemberRow) {
    await this
      .q`insert into geoziptag.team_members (id, team_id, account_id, status, joined_at, removed_at, removed_by)
      values (${m.id}, ${m.team_id}, ${m.account_id}::uuid, ${m.status}, ${m.joined_at}, ${m.removed_at}, ${m.removed_by})`
  }
  async updateMember(id: string, patch: Partial<Pick<MemberRow, 'status' | 'removed_at' | 'removed_by'>>) {
    await this.q`update geoziptag.team_members set
        status = coalesce(${patch.status ?? null}, status),
        removed_at = case when ${'removed_at' in patch} then ${
      patch.removed_at ?? null
    }::timestamptz else removed_at end,
        removed_by = case when ${'removed_by' in patch} then ${patch.removed_by ?? null} else removed_by end
      where id = ${id}`
  }
  async activeMembershipsForAccount(accountId: string) {
    const r = await this
      .q`select * from geoziptag.team_members where account_id = ${accountId}::uuid and status = 'active'`
    return r as unknown as MemberRow[]
  }
  async listMembers(f: { team_id: string; status?: string }, args: PageArgs) {
    const c = decodeCursor(args.cursor) as [string, string] | null
    const q = this.q
    const rows = await q`select * from geoziptag.team_members where team_id = ${f.team_id}
      ${f.status !== undefined ? q`and status = ${f.status}` : q``}
      ${c ? q`and (joined_at, id) < (${new Date(c[0])}, ${c[1]}::uuid)` : q``}
      order by joined_at desc, id desc limit ${args.limit + 1}`
    return pageOf(rows as unknown as MemberRow[], args, (r) => [iso(r.joined_at), r.id])
  }
}

/** `url` is SUPABASE_DB_URL. `prepare: false` keeps it working behind Supabase's transaction pooler. */
export function pgStore(url: string): Store & { close(): Promise<void> } {
  const sql = postgres(url, { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 })
  return {
    tx: <T>(fn: (tx: Tx) => Promise<T>) => sql.begin((t) => fn(new PgTx(t))) as Promise<T>,
    close: () => sql.end(),
  }
}
