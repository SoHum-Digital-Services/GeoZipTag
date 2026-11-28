// Optional: runs the same behaviour tests against a throwaway local Postgres when GEOZIPTAG_TEST_DB_URL is set
// (an EMPTY local database; never a live one). It applies the migration file, plus a stub of public.geoziptag_teams.
import postgres from 'postgres'
import { pgStore } from '../pg_store.ts'
import type { PgHarness } from './helpers.ts'

export const pgUrl = Deno.env.get('GEOZIPTAG_TEST_DB_URL')
const migration = new URL('../../../migrations/0001_geoziptag_entitlements.sql', import.meta.url)
const rollback = new URL('../../../rollbacks/0001_geoziptag_entitlements.down.sql', import.meta.url)

function assertLocal(url: string) {
  const u = new URL(url)
  if (
    !['localhost', '127.0.0.1', '[::1]', ''].includes(u.hostname) &&
    !u.searchParams.get('host')?.startsWith('/')
  ) {
    throw new Error('GEOZIPTAG_TEST_DB_URL must point at a local database')
  }
}

export async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  assertLocal(pgUrl!)
  const sql = postgres(pgUrl!, { max: 1, onnotice: () => {} })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

export const sqlFile = (u: URL) => Deno.readTextFileSync(u)

export async function migrateUp(sql: postgres.Sql) {
  await sql.unsafe(sqlFile(migration))
}
export async function migrateDown(sql: postgres.Sql) {
  await sql.unsafe(sqlFile(rollback))
}

export async function pgHarness(): Promise<PgHarness> {
  await withAdmin(async (sql) => {
    const [{ has }] = await sql`select to_regnamespace('geoziptag') is not null as has`
    if (!has) await migrateUp(sql)
    await sql`create table if not exists public.geoziptag_teams (id text primary key, name text not null, code text not null unique)`
    await sql`truncate geoziptag.entitlements, geoziptag.redeem_codes, geoziptag.redemptions, geoziptag.team_members,
      geoziptag.proposals, geoziptag.idempotency, geoziptag.request_log, geoziptag.rate_counters, geoziptag.audit cascade`
    await sql`truncate public.geoziptag_teams`
  })
  const store = pgStore(pgUrl!)
  const admin = postgres(pgUrl!, { max: 1, onnotice: () => {} })
  const tables = ['entitlements', 'redeem_codes', 'redemptions', 'team_members']
  return {
    store,
    addTeam: async (id, name, code) => {
      await admin`insert into public.geoziptag_teams (id, name, code) values (${id}, ${name}, ${code})`
    },
    dump: async () => {
      const all = [
        'entitlements',
        'redeem_codes',
        'redemptions',
        'team_members',
        'proposals',
        'idempotency',
        'request_log',
        'rate_counters',
        'audit',
      ]
      const parts: string[] = []
      for (const t of all) {
        parts.push(JSON.stringify(await admin`select row_to_json(x) as r from ${admin('geoziptag.' + t)} x`))
      }
      return parts.join('\n')
    },
    counts: async () => {
      const out: Record<string, number> = {}
      for (const t of tables) {
        const [{ n }] = await admin`select count(*)::int as n from ${admin('geoziptag.' + t)}`
        out[t === 'redeem_codes' ? 'codes' : t === 'team_members' ? 'members' : t] = n
      }
      return out
    },
    close: async () => {
      await store.close()
      await admin.end()
    },
  }
}
