// The behaviour tests (S3 to S12), run against the in-memory fake and, when GEOZIPTAG_TEST_DB_URL is set, a local Postgres.
import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { ALPHABET } from '../codes.ts'
import { checkShape, type Env, makeEnv, openSigned, qs, rid, TOKENS, uuid } from './helpers.ts'
import { pgHarness, pgUrl } from './pg.ts'

const kinds: ('memory' | 'pg')[] = pgUrl ? ['memory', 'pg'] : ['memory']
const A = '/geoziptag-actions'

function suite(kind: 'memory' | 'pg', name: string, fn: (env: Env) => Promise<void>) {
  Deno.test(`[${kind}] ${name}`, async () => {
    const env = await makeEnv(kind, { pg: pgHarness })
    try {
      await fn(env)
    } finally {
      await env.close()
    }
  })
}

const newCode = (env: Env, over: Record<string, unknown> = {}) =>
  env.write('create_redeem_code', { label: 'Launch', kind: 'trial', days: 7, max_redemptions: 3, ...over })

for (const kind of kinds) {
  suite(kind, 'S3 credential failures: nothing runs, nothing changes', async (env) => {
    const path = `${A}/grant_entitlement/propose`
    const body = { subject_kind: 'install', subject_id: uuid(), source: 'admin', days: 5 }
    const ts = Math.floor(env.clock.now.getTime() / 1000)
    const before = await env.counts()
    const status = async (o: Parameters<Env['admin']>[3]) => (await env.admin('POST', path, body, o)).status
    assertEquals(await status({ signature: '' }), 401, 'no signature')
    assertEquals(await status({ signature: 'a'.repeat(64) }), 401, 'wrong signature')
    assertEquals(await status({ secret: 'some-other-secret' }), 401, 'signed with another secret')
    assertEquals(await status({ timestamp: String(ts - 301) }), 401, 'old')
    assertEquals(await status({ timestamp: String(ts + 301) }), 401, 'ahead')
    const once = rid()
    assertEquals(await status({ requestId: once }), 200)
    assertEquals(await status({ requestId: once }), 401, 'replayed request id')
    assertEquals(await status({ role: 'viewer' }), 403)
    assertEquals(await status({ role: 'admin' }), 403)
    assertEquals(await status({ role: 'operator' }), 200)
    assertEquals(await env.counts(), before)
    // a signature made for another path or method does not carry over
    const sigForOther = await (await import('../hmac.ts')).sign(
      (await import('./helpers.ts')).SECRET,
      String(ts),
      'POST',
      `${A}/revoke_entitlement/propose`,
      new TextEncoder().encode(JSON.stringify(body)),
    )
    assertEquals(await status({ signature: sigForOther }), 401)
    // both URL forms work
    assertEquals((await env.admin('GET', `${A}/list_redeem_codes`, undefined, { prefix: '' })).status, 200)
    assertEquals(
      (await env.admin('GET', `${A}/list_redeem_codes`, undefined, { prefix: '/functions/v1' })).status,
      200,
    )
  })

  suite(kind, 'S4 propose changes nothing; confirm twice with one key acts once', async (env) => {
    const before = await env.counts()
    const params = { subject_kind: 'install', subject_id: uuid(), source: 'admin', days: 30, note: 'test' }
    const p = await (await env.admin('POST', `${A}/grant_entitlement/propose`, params)).json()
    assertEquals(await env.counts(), before)
    assert(p.data.proposal_id && p.data.expires_at && p.data.summary)
    const key = 'idem-key-0001'
    const confirm = () =>
      env.admin('POST', `${A}/grant_entitlement/confirm`, {
        proposal_id: p.data.proposal_id,
        idempotency_key: key,
      })
    const r1 = await (await confirm()).json()
    const r2 = await (await confirm()).json()
    assertEquals(r1.data, r2.data)
    assertEquals((await env.counts()).entitlements, before.entitlements + 1)
    checkShape('entitlement', r1.data)
    assertEquals(r1.success, true)
    // unknown fields are rejected
    const bad = await env.admin('POST', `${A}/grant_entitlement/propose`, { ...params, surprise: 1 })
    assertEquals(bad.status, 422)
    assertEquals((await bad.json()).error.code, 'INVALID_PARAMS')
  })

  suite(kind, 'S5 expired, unknown and re-keyed proposals are 409', async (env) => {
    const params = { subject_kind: 'install', subject_id: uuid(), source: 'admin', days: 3 }
    const propose = async () =>
      (await (await env.admin('POST', `${A}/grant_entitlement/propose`, params)).json()).data.proposal_id
    const confirm = (id: string, key: string) =>
      env.admin('POST', `${A}/grant_entitlement/confirm`, { proposal_id: id, idempotency_key: key })
    assertEquals((await confirm('p_nope', 'idem-key-0002')).status, 409)
    const id = await propose()
    env.clock.now = new Date(env.clock.now.getTime() + 16 * 60_000)
    assertEquals((await confirm(id, 'idem-key-0003')).status, 409)
    env.clock.now = new Date(env.clock.now.getTime() - 16 * 60_000)
    const id2 = await propose()
    assertEquals((await confirm(id2, 'idem-key-0004')).status, 200)
    assertEquals((await confirm(id2, 'idem-key-0005')).status, 409, 'different key on a confirmed proposal')
    assertEquals((await env.counts()).entitlements, 1)
  })

  suite(kind, 'S6 the readable code appears once and is never stored or listed', async (env) => {
    const created = await newCode(env)
    checkShape('redeem_code#created', created)
    assert(
      /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(created.code) &&
        [...created.code.replace('-', '')].every((c) => ALPHABET.includes(c)),
    )
    const plain = created.code.replace('-', '')
    const list = JSON.stringify(await env.read('list_redeem_codes'))
    assert(!list.includes(plain) && !list.includes(created.code))
    const dump = await env.dump()
    assert(!dump.includes(plain) && !dump.includes(created.code), 'stored data must not hold the code')
    assert(dump.includes(created.code.slice(-4)))
    checkShape('redeem_code', (await env.read('list_redeem_codes')).items[0])
    // a retried confirm (same key) shows the same code to the caller that made it
    const p = await (await env.admin('POST', `${A}/create_redeem_code/propose`, {
      label: 'x',
      kind: 'coupon',
      days: 1,
      max_redemptions: 1,
    })).json()
    const body = { proposal_id: p.data.proposal_id, idempotency_key: 'idem-key-code1' }
    const c1 = await (await env.admin('POST', `${A}/create_redeem_code/confirm`, body)).json()
    const c2 = await (await env.admin('POST', `${A}/create_redeem_code/confirm`, body)).json()
    assertEquals(c1.data, c2.data)
    assertEquals((await env.counts()).codes, 2)
  })

  suite(kind, 'S7 a 3-use code: exactly 3 of 4 succeed, two at once for the last use', async (env) => {
    const { code, redeem_code } = await newCode(env)
    const ids = [uuid(), uuid(), uuid(), uuid()]
    assertEquals((await env.redeem(ids[0], code)).status, 200)
    assertEquals((await env.redeem(ids[1], code)).status, 200)
    const last = await Promise.all([env.redeem(ids[2], code), env.redeem(ids[3], code)])
    assertEquals(last.map((r) => r.status).sort(), [200, 422])
    const c = await env.read('list_redeem_codes')
    assertEquals(c.items[0].redeemed_count, 3)
    assertEquals((await env.read('list_redemptions', { code_id: redeem_code.id })).items.length, 3)
    assertEquals((await env.counts()).redemptions, 3)
    assertEquals((await env.counts()).entitlements, 3)
    // all four at the same moment on a fresh code
    const fresh = await newCode(env, { label: 'race' })
    const all = await Promise.all([uuid(), uuid(), uuid(), uuid()].map((i) => env.redeem(i, fresh.code)))
    assertEquals(all.filter((r) => r.status === 200).length, 3)
    assertEquals(all.filter((r) => r.status === 422).length, 1)
  })

  suite(kind, 'S8 the same install redeeming twice gets the same entitlement, counted once', async (env) => {
    const { code } = await newCode(env)
    const id = uuid()
    const a = await (await env.redeem(id, code.toLowerCase().replace('-', ' '))).json()
    const b = await (await env.redeem(id, code)).json()
    assertEquals((await openSigned(env, a.data)).ends_at, (await openSigned(env, b.data)).ends_at)
    assertEquals((await env.read('list_redeem_codes')).items[0].redeemed_count, 1)
    assertEquals((await env.counts()).entitlements, 1)
    assertEquals((await env.counts()).redemptions, 1)
  })

  suite(kind, 'S9 unknown, expired, disabled and used-up codes give one identical 422', async (env) => {
    const fresh = uuid
    const expiring = await newCode(env, {
      label: 'soon',
      valid_until: '2026-12-02T00:00:00Z',
      max_redemptions: 5,
    })
    const toDisable = await newCode(env, { label: 'off', max_redemptions: 5 })
    const single = await newCode(env, { label: 'one', max_redemptions: 1 })
    await env.write('set_redeem_code_enabled', { code_id: toDisable.redeem_code.id, enabled: false })
    assertEquals((await env.redeem(fresh(), single.code)).status, 200)
    env.clock.now = new Date('2026-12-03T09:30:00Z')
    const bodies: string[] = []
    for (const c of ['ABCD-EFGH', expiring.code, toDisable.code, single.code]) {
      const r = await env.redeem(fresh(), c)
      assertEquals(r.status, 422)
      bodies.push(JSON.stringify(await r.json()))
    }
    assertEquals(new Set(bodies).size, 1)
    assertEquals(JSON.parse(bodies[0]).error.code, 'INVALID_CODE')
  })

  suite(kind, 'redeem is rate limited per install', async (env) => {
    const id = uuid()
    let last = 0
    for (let i = 0; i < 11; i++) last = (await env.redeem(id, 'AAAA-BBBB')).status
    assertEquals(last, 429)
  })

  suite(kind, 'S11 check_entitlement: active, disabled, ended, none', async (env) => {
    const { code } = await newCode(env, { days: 3 })
    const id = uuid()
    const check = async () =>
      (await (await env.app('POST', 'check_entitlement', { install_id: id })).json()).data
    assertEquals(await check(), null)
    await env.redeem(id, code)
    let p = await openSigned(env, await check())
    assertEquals([p.enabled, p.source, p.subject.id], [true, 'trial', id])
    const ent = (await env.read('list_entitlements', { subject_kind: 'install' })).items[0]
    await env.write('set_entitlement_enabled', { entitlement_id: ent.id, enabled: false })
    p = await openSigned(env, await check())
    assertEquals(p.enabled, false)
    await env.write('set_entitlement_enabled', { entitlement_id: ent.id, enabled: true })
    assertEquals((await openSigned(env, await check())).enabled, true)
    env.clock.now = new Date(env.clock.now.getTime() + 4 * 86_400_000)
    p = await openSigned(env, await check())
    assert(new Date(p.ends_at) < env.clock.now)
    assert(new Date(p.grace_until) <= new Date(p.ends_at))
    // an admin revoke ends it now
    env.clock.now = new Date('2026-12-01T10:00:00Z')
    await env.write('revoke_entitlement', { entitlement_id: ent.id })
    env.clock.now = new Date('2026-12-01T10:01:00Z')
    assertEquals((await openSigned(env, await check())).ends_at, '2026-12-01T10:00:00Z')
  })

  suite(
    kind,
    'S11 teams: plan inherited by signed-in members, removal and plan changes take effect',
    async (env) => {
      await env.addTeam('team-1', 'Site Crew', 'AB12CD')
      const account = uuid()
      TOKENS['tok-good'] = account
      const bearer = { authorization: 'Bearer tok-good' }
      const inst = uuid()
      const check = async (h: Record<string, string> = {}) =>
        (await (await env.app('POST', 'check_entitlement', { install_id: inst }, h)).json()).data
      const join = (h: Record<string, string> = bearer, code = 'ab12cd') =>
        env.app('POST', 'join_team', { install_id: inst, team_code: code }, h)
      assertEquals((await join({})).status, 401)
      assertEquals((await join({ authorization: 'Bearer nope' })).status, 401)
      assertEquals((await join(bearer, 'ZZZZZZ')).status, 404)
      const m1 = await (await join()).json()
      checkShape('team_member', m1.data)
      assertEquals((await (await join()).json()).data.id, m1.data.id, 'a repeat returns the same membership')
      assertEquals(await check(bearer), null, 'a team with no plan gives nothing')
      const plan = await env.write('change_team_plan', {
        team_id: 'team-1',
        plan: 'pro',
        ends_at: '2027-12-01T00:00:00Z',
      })
      checkShape('team_plan', plan)
      assertEquals(plan.plan, 'pro')
      const p = await openSigned(env, await check(bearer))
      assertEquals([p.source, p.subject.kind, p.subject.id, p.team_id], [
        'team',
        'account',
        account,
        'team-1',
      ])
      assertEquals(await check(), null, 'no token: only the install entitlement applies')
      // the later-ending of own and team wins
      const { code } = await newCode(env, { days: 7 })
      await env.redeem(inst, code)
      assertEquals((await openSigned(env, await check(bearer))).source, 'team')
      assertEquals((await openSigned(env, await check())).source, 'trial')
      // disabling the plan, then re-enabling, then changing it to free
      const row = (await env.read('list_entitlements', { subject_kind: 'team' })).items[0]
      await env.write('set_entitlement_enabled', { entitlement_id: row.id, enabled: false })
      assertEquals((await openSigned(env, await check(bearer))).source, 'trial')
      await env.write('set_entitlement_enabled', { entitlement_id: row.id, enabled: true })
      assertEquals((await openSigned(env, await check(bearer))).source, 'team')
      // removal
      const members = await env.read('list_team_members', { team_id: 'team-1' })
      checkShape('team_member', members.items[0])
      const removed = await env.write('remove_team_member', { membership_id: m1.data.id })
      assertEquals(removed.status, 'removed')
      assertEquals((await openSigned(env, await check(bearer))).source, 'trial')
      assertEquals((await join()).status, 409, 'a removal sticks')
      const free = await env.write('change_team_plan', { team_id: 'team-1', plan: 'free' })
      assertEquals(free.plan, 'free')
      assertEquals(
        (await env.write('change_team_plan', { team_id: 'nope', plan: 'free' }).catch((e) => e.message))
          .includes('404'),
        true,
      )
    },
  )

  suite(kind, 'S12 admin reads mask ids, hide small counts, and page every row once', async (env) => {
    const ids = Array.from({ length: 7 }, () => uuid())
    for (const id of ids) {
      await env.write('grant_entitlement', {
        subject_kind: 'install',
        subject_id: id,
        source: 'admin',
        days: 5,
      })
    }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await env.read('list_entitlements', { limit: 3, ...(cursor ? { cursor } : {}) })
      for (const e of page.items) {
        checkShape('entitlement', e)
        assert(/^.{4}….{4}$/.test(e.subject.id))
        assert(!ids.includes(e.subject.id))
        seen.push(e.id)
      }
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    assertEquals(seen.length, 7)
    assertEquals(new Set(seen).size, 7)
    assert(!JSON.stringify(await env.read('list_entitlements', { limit: 200 })).includes(ids[0]))

    const { code, redeem_code } = await newCode(env, { max_redemptions: 5 })
    const inst = uuid()
    await env.redeem(inst, code)
    const log = await env.read('list_redemptions', { code_id: redeem_code.id })
    checkShape('redemption', log.items[0])
    assert(!JSON.stringify(log).includes(inst))

    await env.addTeam('t-small', 'Small', 'SMALL1')
    await env.addTeam('t-big', 'Big', 'BIGONE')
    const store = env.store
    await store.tx(async (tx) => {
      for (let i = 0; i < 10; i++) {
        await tx.insertMember({
          id: uuid(),
          team_id: 't-big',
          account_id: uuid(),
          status: 'active',
          joined_at: env.clock.now,
          removed_at: null,
          removed_by: null,
        })
      }
      for (let i = 0; i < 3; i++) {
        await tx.insertMember({
          id: uuid(),
          team_id: 't-small',
          account_id: uuid(),
          status: 'active',
          joined_at: env.clock.now,
          removed_at: null,
          removed_by: null,
        })
      }
    })
    const plans = await env.read('list_team_plans')
    for (const t of plans.items) checkShape('team_plan', t)
    assertEquals(plans.items.find((t: { team_id: string }) => t.team_id === 't-big').member_count, 10)
    assertEquals(
      'member_count' in plans.items.find((t: { team_id: string }) => t.team_id === 't-small'),
      false,
    )
    assertEquals((await env.read('list_team_plans', { plan: 'pro' })).items.length, 0)
    assertEquals((await env.read('list_team_plans', { limit: 1 })).next_cursor !== null, true)
    // a bad cursor and bad query values are 422
    assertEquals((await env.admin('GET', `${A}/list_entitlements?cursor=%21%21`)).status, 422)
    assertEquals((await env.admin('GET', `${A}/list_entitlements?${qs({ limit: 500 })}`)).status, 422)
  })

  suite(kind, 'audit: every admin call is recorded without codes or full install ids', async (env) => {
    const inst = uuid()
    const { code } = await newCode(env)
    await env.write('grant_entitlement', {
      subject_kind: 'install',
      subject_id: inst,
      source: 'admin',
      days: 5,
    })
    await env.read('list_redeem_codes')
    await env.admin('POST', `${A}/grant_entitlement/propose`, {}, { role: 'viewer' })
    const dump = await env.dump()
    assert(!dump.includes(code.replace('-', '')))
    if (env.mem) {
      const a = env.mem.state.audit
      assert(a.some((r) => r.phase === 'confirm' && r.outcome === 'ok'))
      assert(a.some((r) => r.outcome === 'denied'))
      assert(!JSON.stringify(a).includes(inst))
    }
  })

  suite(kind, 'public endpoints: health, manifest, keys, cors, unknown routes', async (env) => {
    const get = (p: string) =>
      env.handle(new Request(`https://example.test/functions/v1/geoziptag-actions/${p}`))
    const h = await (await get('health')).json()
    assertEquals(h.ok, true)
    assert(typeof h.version === 'string')
    assertEquals((await (await get('manifest')).json()).product, 'geoziptag')
    const keys = await (await get('get_public_keys')).json()
    checkShape('entitlement#public_keys', keys.data)
    assertEquals(
      (await env.handle(
        new Request('https://example.test/geoziptag-actions/redeem_code', { method: 'OPTIONS' }),
      )).status,
      204,
    )
    assertEquals((await get('nope')).status, 404)
    assertEquals((await env.handle(new Request('https://example.test/elsewhere'))).status, 404)
    assertEquals(
      (await env.app('POST', 'redeem_code', { install_id: 'not-a-uuid', code: 'AAAA' })).status,
      422,
    )
    assertEquals(
      (await env.app('POST', 'redeem_code', { install_id: uuid(), code: 'AAAA', extra: 1 })).status,
      422,
    )
    // admin actions are not reachable without the credential
    assertEquals(
      (await env.handle(new Request('https://example.test/geoziptag-actions/list_redeem_codes'))).status,
      401,
    )
    assertNotEquals((await get('list_redeem_codes')).status, 200)
  })
}
