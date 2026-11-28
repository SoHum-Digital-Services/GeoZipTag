// S13: the migration runs up, down, up on an empty local database. Needs GEOZIPTAG_TEST_DB_URL (a local, empty database).
import { assertEquals } from '@std/assert'
import { migrateDown, migrateUp, pgUrl, withAdmin } from './pg.ts'

Deno.test({
  name: 'S13 migration up, down, up (local Postgres only)',
  ignore: !pgUrl,
  fn: async () => {
    await withAdmin(async (sql) => {
      const has = async () => (await sql`select to_regnamespace('geoziptag') is not null as has`)[0].has
      if (await has()) await migrateDown(sql)
      await migrateUp(sql)
      assertEquals(await has(), true)
      const rls =
        await sql`select count(*)::int as n from pg_tables where schemaname = 'geoziptag' and rowsecurity`
      const pol = await sql`select count(*)::int as n from pg_policies where schemaname = 'geoziptag'`
      assertEquals([rls[0].n, pol[0].n], [9, 0])
      await migrateDown(sql)
      assertEquals(await has(), false)
      await migrateUp(sql)
      assertEquals(await has(), true)
    })
  },
})
