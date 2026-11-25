// 同期（src/lib/sync.ts）と役割ごとの権限を、アプリの本物のコードで通しで確かめる。
//
// - データベースは手元の Postgres（supabase/tests/run_local.sh で作ったもの）。本番には触れない
// - Supabase のクライアントだけを差し替え、アプリと同じ呼び出しを「その人としての SQL」に置き換える
//   （権限＝RLS と関数は、本番と同じマイグレーションがそのまま働く）
// - 端末ごとに別々の実行環境を作り、記録の入力 → 同期 → 別の端末で受け取る、を再現する
//
// 流し方（web/ で）:
//   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres ./supabase/tests/run_local.sh
//   npm i --no-save pg
//   PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres PGDATABASE=physlog_test node tests/sync-roles.test.mjs

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = process.env.PGDATABASE ?? ''
if (!db.startsWith('physlog_test')) {
  console.error('手元のテスト用データベース（名前が physlog_test で始まるもの）でだけ動かします。PGDATABASE を指定してください。')
  process.exit(2)
}
const pool = new pg.Pool({ max: 4 })

// ───────── アプリのコードを1つにまとめる（端末ごとに読み込み直すため） ─────────

const bundle = (await build({
  stdin: {
    contents: `export * as sync from './src/lib/sync'\nexport { actions, onMemberRemap } from './src/store'\n`,
    resolveDir: path.join(here, '..'), loader: 'ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  external: ['@supabase/supabase-js'],
  define: { 'import.meta.env.MODE': '"test"', 'process.env.NODE_ENV': '"production"' },
})).outputFiles[0].text

// ───────── Supabase クライアントの代わり（その人としての SQL を流す） ─────────

class Query {
  constructor(fake, table) { this.fake = fake; this.table = table; this.filters = []; this.rows = null }
  select(cols) { this.cols = cols; return this }
  eq(c, v) { this.filters.push([c, '=', v]); return this }
  gt(c, v) { this.filters.push([c, '>', v]); return this }
  order(c, o) { this.orderBy = (this.orderBy ? this.orderBy + ', ' : '') + `${c} ${o?.ascending === false ? 'desc' : 'asc'}`; return this }
  limit(n) { this.max = n; return this }
  range(from, to) { this.offset = from; this.max = to - from + 1; return this }
  upsert(rows, o) { this.rows = rows; this.conflict = o.onConflict; return this }
  then(ok, ng) { return this.run().then(ok, ng) }
  run() {
    assert.match(this.table, /^[a-z_]+$/)
    if (this.rows) {
      // PostgREST の upsert と同じ形（送られた列だけを入れ、ぶつかったら同じ列を上書き）
      const cols = Object.keys(this.rows[0])
      const sql = `insert into public.${this.table} (${cols.join(', ')}) select ${cols.join(', ')} from json_populate_recordset(null::public.${this.table}, $1::json)`
        + ` on conflict (${this.conflict}) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`
      return this.fake.as(async (c) => { await c.query(sql, [JSON.stringify(this.rows)]); return null })
    }
    const where = this.filters.map(([c, op], i) => `${c} ${op} $${i + 1}`).join(' and ')
    const sql = `select coalesce(json_agg(t), '[]'::json) as v from (select ${this.cols} from public.${this.table}`
      + `${where ? ' where ' + where : ''}${this.orderBy ? ' order by ' + this.orderBy : ''}${this.max ? ' limit ' + this.max : ''}${this.offset ? ' offset ' + this.offset : ''}) t`
    return this.fake.as(async (c) => (await c.query(sql, this.filters.map((f) => f[2]))).rows[0].v)
  }
}

class Fake {
  constructor(user) { this.user = user; this.calls = 0; this.failOnce = new Set() } // failOnce：次の1回だけ失敗させる関数名（通信の失敗を再現）
  auth = {
    getSession: async () => ({ data: { session: this.user ? { user: this.user } : null } }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  }
  from(table) { return new Query(this, table) }
  /** その人（authenticated ロール＋JWT の sub）として実行する。失敗は Supabase と同じく { error } で返す */
  async as(fn) {
    this.calls++
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: this.user.id, role: 'authenticated' })])
      await c.query('set local role authenticated')
      const data = await fn(c)
      await c.query('commit')
      return { data, error: null }
    } catch (e) {
      await c.query('rollback').catch(() => {})
      return { data: null, error: { code: e.code, message: e.message } }
    } finally { c.release() }
  }
  /** PostgREST と同じ返し方：表を返す関数は配列、1行（複合型）はオブジェクト、void は null、それ以外は値 */
  rpc(name, args = {}) {
    assert.match(name, /^[a-z_]+$/)
    if (this.failOnce.delete(name)) return Promise.resolve({ data: null, error: { code: '', message: 'Failed to fetch' } })
    const keys = Object.keys(args)
    const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
    const vals = keys.map((k) => args[k])
    return this.as(async (c) => {
      const f = (await c.query(`select p.proretset, t.typtype, t.typname from pg_proc p join pg_type t on t.oid = p.prorettype where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [name])).rows[0]
      if (!f) throw Object.assign(new Error(`function ${name} not found`), { code: 'PGRST202' })
      if (f.proretset) return (await c.query(`select coalesce(json_agg(t), '[]'::json) as v from ${call} t`, vals)).rows[0].v
      if (f.typname === 'void') { await c.query(`select ${call}`, vals); return null }
      if (f.typtype === 'c') return (await c.query(`select row_to_json(t) as v from ${call} t`, vals)).rows[0].v
      return (await c.query(`select to_json(${call}) as v`, vals)).rows[0].v
    })
  }
}

// ───────── 端末（アプリの実行環境を1つずつ分ける） ─────────

const admin = (sql, params) => pool.query(sql, params).then((r) => r.rows)

async function makeUser(label) {
  const id = randomUUID()
  const email = `${label}-${id.slice(0, 8)}@example.invalid`
  await admin('insert into auth.users (id, email) values ($1, $2)', [id, email])
  return { id, email }
}

function makeDevice(user, stored = {}) {
  const store = new Map(Object.entries(stored))
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
  const mod = { exports: {} }
  const ctx = vm.createContext({
    module: mod, exports: mod.exports,
    require: (n) => { if (n === '@supabase/supabase-js') return { createClient: () => { throw new Error('テストでは本物のクライアントを作らない') } }; throw new Error('unexpected require: ' + n) },
    localStorage, console, crypto: globalThis.crypto, queueMicrotask, process: { env: { NODE_ENV: 'production' } },
    // 自動の同期（タイマー）は止め、テストから syncNow を呼ぶ
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    document: { addEventListener() {}, visibilityState: 'visible' }, window: { addEventListener() {} },
  })
  vm.runInContext(bundle, ctx)
  const { sync, actions, onMemberRemap } = mod.exports
  const fake = new Fake(user)
  sync.__setClient(fake)
  const remaps = []
  onMemberRemap((m) => remaps.push(Object.fromEntries(m)))
  // 端末の中の値は別の実行環境のものなので、比べる前にふつうの値へ写す
  return { user, sync, actions, fake, remaps, st: () => plain(sync.syncState()), data: () => plain(actions.getState()) }
}

const plain = (x) => JSON.parse(JSON.stringify(x))
const tick = () => new Promise((r) => setImmediate(r)) // 記録の変更が送信待ちに積まれるのを待つ
const syncAll = async (...devs) => { await tick(); for (const d of devs) await d.sync.syncNow() }
const ids = (l) => l.map((x) => x.id).sort()
const names = (d) => d.data().members.map((m) => m.name).sort()
const server = (ws, where = 'true') => admin(`select collection, id, member_id, deleted, data, updated_by from public.records where workspace_id = $1 and ${where} order by collection, id`, [ws])
const session = (id, extra = {}) => ({ id, date: '2026-11-24', sport: '', memo: '', exercises: [], ...extra })
const count = async (where, params) => Number((await admin(`select count(*) as n from public.records where ${where}`, params))[0].n)
const heldCount = async (ws, user) => Number((await admin('select count(*) as n from public.held_records where workspace_id = $1 and user_id = $2', [ws, user.id]))[0].n)
/** その人の、消えていない記録の数（グループの側） */
const liveOf = (ws, memberId) => count(`workspace_id = $1 and member_id = $2 and not deleted and collection <> 'members'`, [ws, memberId])
const departed = async (dev) => plain(await dev.sync.listDeparted()).map((d) => `${d.member_name}/${d.handover}`)

let passed = 0
const check = async (label, fn) => { await fn(); passed++; console.log('PASS', label) }

// ───────── 筋書き ─────────

try {
  // 前の実行の残りを片づける（テスト専用のデータベース）
  await admin('truncate public.invites, public.records, public.workspace_members, public.workspaces, auth.users cascade')

  const [uO, uK, uC, uX] = await Promise.all(['owner', 'katsura', 'coach', 'stranger'].map(makeUser))
  const O1 = makeDevice(uO), K = makeDevice(uK), C = makeDevice(uC)
  let ws, kat, ryotaId

  await check('管理者：この端末の記録で同期を始めると、全員分がサーバーに入る', async () => {
    O1.actions.renameMember('me', 'Ryota')
    kat = O1.actions.addMember('Katsura', false)
    O1.actions.saveSession(session('s-r1'))
    O1.actions.saveSession(session('s-k1', { memberId: kat.id, memo: 'coach entered' }))
    O1.actions.saveBody({ id: 'b-k1', memberId: kat.id, date: '2026-11-24', weight: 72, memo: '' })
    O1.actions.setProfile({ name: 'Ryota', sport: 'バスケットボール' })
    O1.actions.upsertMany('conditions', [{ id: 'hc:me:2026-11-22', memberId: 'me', date: '2026-11-22', sleep: 7, memo: '' }])
    await O1.sync.createWorkspace('PhysLog')
    ws = O1.st().workspaceId
    assert.equal(O1.st().role, 'owner')
    assert.deepEqual(O1.st().outbox, [])
    ryotaId = O1.data().members.find((m) => m.name === 'Ryota').id
    assert.notEqual(ryotaId, 'me', '各端末で同じ me は、ぶつからないIDに付け替わる')
    const rows = await server(ws)
    assert.deepEqual(rows.map((r) => `${r.collection}/${r.id}/${r.member_id}`).sort(), [
      `bodies/b-k1/${kat.id}`, `conditions/hc:${ryotaId}:2026-11-22/${ryotaId}`, `members/${kat.id}/${kat.id}`, `members/${ryotaId}/${ryotaId}`,
      'profile/profile/null', `sessions/s-k1/${kat.id}`, `sessions/s-r1/${ryotaId}`,
    ].sort())
  })

  let codeK
  await check('管理者：本人（Katsura）の招待コードを作れる。指導者・本人には作れない', async () => {
    const inv = await O1.sync.createInvite('client', kat.id)
    codeK = inv.code
    assert.match(codeK, /^[2-9A-HJ-NP-Z]{10}$/)
    assert.equal((await O1.sync.listInvites()).length, 1)
  })

  await check('本人：参加する前に、招待の中身（グループ・役割・誰の記録か）を確かめられる', async () => {
    K.actions.saveSession(session('s-k-own', { date: '2026-11-23', memo: 'my own before joining' }))
    K.actions.setProfile({ name: 'Katsura', sport: '' })
    // 参加前にヘルスケアから取り込んだ記録。IDは管理者の端末のものと同じ（どの端末でも最初は me）
    K.actions.upsertMany('conditions', [{ id: 'hc:me:2026-11-22', memberId: 'me', date: '2026-11-22', sleep: 6, memo: '' }])
    K.actions.upsertMany('bodies', [{ id: 'hb:me:2026-11-22', memberId: 'me', date: '2026-11-22', weight: 72.4, memo: '' }])
    K.actions.upsertMany('activities', [{ id: 'hc:bike:me:2026-11-22', memberId: 'me', date: '2026-11-22', kind: 'bike', distance: 5, memo: '' }])
    const shown = `${codeK.slice(0, 5)}-${codeK.slice(5)}`.toLowerCase()
    const info = await K.sync.inviteInfo(shown)
    assert.deepEqual(plain(info), { workspace_name: 'PhysLog', role: 'client', member_name: 'Katsura', already_member: false })
    assert.equal(K.st().workspaceId, undefined, '確かめただけでは参加しない')
  })

  await check('本人：参加すると自分の記録だけが届き、この端末の記録は自分のものとして送られる', async () => {
    await K.sync.joinWorkspace(`${codeK.slice(0, 5)}-${codeK.slice(5)}`)
    assert.equal(K.st().role, 'client')
    assert.equal(K.st().memberId, kat.id)
    assert.deepEqual(K.data().members, [{ id: kat.id, name: 'Katsura' }], '人は自分だけ。名前はサーバーのもの')
    assert.equal(K.data().activeMemberId, kat.id)
    assert.deepEqual(ids(K.data().sessions), ['s-k-own', 's-k1'])
    assert.deepEqual(ids(K.data().bodies), ['b-k1', `hb:${kat.id}:2026-11-22`])
    assert.ok(K.data().sessions.every((s) => s.memberId === kat.id))
    // ヘルスケア由来の記録は、IDの中の「誰」も付け替わる。管理者の同じ日の記録とぶつからず、上書きもしない
    assert.deepEqual(ids(K.data().conditions), [`hc:${kat.id}:2026-11-22`])
    assert.deepEqual(ids(K.data().activities), [`hc:bike:${kat.id}:2026-11-22`])
    const sleeps = await server(ws, `collection = 'conditions'`)
    assert.deepEqual(sleeps.map((r) => `${r.id}/${r.member_id}/${r.data.sleep}`).sort(), [`hc:${kat.id}:2026-11-22/${kat.id}/6`, `hc:${ryotaId}:2026-11-22/${ryotaId}/7`].sort())
    assert.deepEqual(K.data().profile, { name: 'Katsura', sport: '' }, 'profile は端末のまま（管理者のものは届かない）')
    assert.deepEqual(K.st().outbox, [])
    assert.ok(!K.st().rejected)
    assert.deepEqual(K.remaps, [{ me: kat.id }], '人のIDの付け替えは、ほかの設定（ヘルスケア連携）にも知らされる')
    const [own] = await server(ws, `id = 's-k-own'`)
    assert.equal(own.member_id, kat.id)
    assert.equal(own.updated_by, uK.id)
    assert.equal((await server(ws, `collection in ('members', 'profile')`)).length, 3, '本人は、人と profile を増やさない')
  })

  await check('管理者：本人が入れた記録が、その人の記録として届く', async () => {
    await syncAll(O1)
    const s = O1.data().sessions.find((x) => x.id === 's-k-own')
    assert.equal(s?.memberId, kat.id)
    assert.deepEqual(names(O1), ['Katsura', 'Ryota'])
  })

  await check('本人が足す → 管理者に届く。管理者が直す → 本人に届く。本人が消す → 管理者からも消える', async () => {
    K.actions.saveBody({ id: 'b-k2', date: '2026-11-25', weight: 71.5, memo: '' })
    await syncAll(K, O1)
    assert.equal(O1.data().bodies.find((x) => x.id === 'b-k2')?.memberId, kat.id)

    O1.actions.saveSession({ ...O1.data().sessions.find((x) => x.id === 's-k-own'), memo: 'coach edited' })
    await syncAll(O1, K)
    assert.equal(K.data().sessions.find((x) => x.id === 's-k-own')?.memo, 'coach edited')

    K.actions.remove('bodies', 'b-k1')
    await syncAll(K, O1)
    assert.ok(!O1.data().bodies.some((x) => x.id === 'b-k1'))
    const [gone] = await server(ws, `id = 'b-k1'`)
    assert.deepEqual([gone.deleted, gone.member_id, gone.data], [true, kat.id, null])
  })

  await check('本人の端末で人や profile を変えても、サーバーには送られず、同期も止まらない', async () => {
    K.actions.addMember('Friend', false)
    K.actions.setProfile({ name: 'K', sport: '陸上' })
    K.actions.saveBody({ id: 'b-k3', date: '2026-11-26', weight: 71, memo: '' })
    await syncAll(K)
    assert.deepEqual(K.st().outbox, [])
    assert.ok(!K.st().rejected)
    const meta = await server(ws, `collection in ('members', 'profile') and not deleted`)
    assert.deepEqual(meta.map((r) => r.data.name).sort(), ['Katsura', 'Ryota', 'Ryota'])
    assert.equal((await server(ws, `id = 'b-k3'`)).length, 1)
  })

  await check('権限で断られる記録が混ざっても、ほかの記録は送られる（断られた件数が残る）', async () => {
    // 本人の端末で、たまたま他人の記録と同じIDの記録ができた場合（サーバー側で断られる）
    K.actions.saveSession(session('s-r1', { memo: 'collide' }))
    K.actions.saveSession(session('s-k-ok', { date: '2026-11-27' }))
    await syncAll(K)
    assert.equal(K.st().rejected, 1)
    assert.deepEqual(K.st().outbox, [])
    const [r1] = await server(ws, `id = 's-r1'`)
    assert.deepEqual([r1.member_id, r1.data.memo], [ryotaId, ''], '他人の記録は変わらない')
    assert.equal((await server(ws, `id = 's-k-ok'`))[0].member_id, kat.id)
  })

  await check('指導者：参加すると全員分が届く。空の「自分」を増やさない。本人の分を代わりに入れられる', async () => {
    const inv = await O1.sync.createInvite('coach')
    await C.sync.joinWorkspace(inv.code)
    assert.equal(C.st().role, 'coach')
    assert.deepEqual(names(C), ['Katsura', 'Ryota'])
    assert.ok(['s-k-own', 's-k1', 's-r1', 's-k-ok'].every((id) => C.data().sessions.some((s) => s.id === id)))
    assert.equal((await server(ws, `collection = 'members'`)).length, 2)
    assert.deepEqual(C.data().profile, { name: 'Ryota', sport: 'バスケットボール' })

    C.actions.setActiveMember(kat.id)
    C.actions.saveSession(session('s-c1', { date: '2026-11-28', memo: 'by coach' }))
    await syncAll(C, K, O1)
    assert.equal(K.data().sessions.find((x) => x.id === 's-c1')?.memo, 'by coach')
    assert.equal((await server(ws, `id = 's-c1'`))[0].updated_by, uC.id, '誰が入れたかが残る')
    assert.ok(!K.data().sessions.some((x) => x.id === 's-r1' && x.memo === ''), '本人には、他人の記録は届かない')
  })

  await check('指導者は、指導者を招く・人を外す・参加者の一覧を見ることができない。本人は、招待もできない', async () => {
    await assert.rejects(C.sync.createInvite('coach'), /管理者だけ/)
    await assert.rejects(K.sync.createInvite('coach'), /管理者だけ/)
    await assert.rejects(C.sync.removePerson(uK.id), /管理者だけ/)
    assert.deepEqual(plain(await C.sync.listPeople()), [])
    assert.deepEqual(plain(await K.sync.listInvites()), [])
    await assert.rejects(K.sync.createInvite('client', kat.id), /管理者だけ/)
    await assert.rejects(O1.sync.leaveWorkspace(true), /管理者は、グループから抜けられません/)
  })

  await check('管理者：参加している人の一覧（役割・誰の記録か・メールアドレス）を見られる', async () => {
    const people = plain(await O1.sync.listPeople())
    assert.deepEqual(people.map((p) => `${p.role}/${p.member_id}/${p.email}`).sort(),
      [`client/${kat.id}/${uK.email}`, `coach/null/${uC.email}`, `owner/null/${uO.email}`].sort())
  })

  await check('管理者の2台目：コードなしで同じグループにつなぎ直せる。空の「自分」を増やさない', async () => {
    const O2 = makeDevice(uO)
    const mine = plain(await O2.sync.myWorkspaces())
    assert.deepEqual(mine.map((w) => `${w.name}/${w.role}`), ['PhysLog/owner'])
    await O2.sync.resumeWorkspace(mine[0])
    assert.deepEqual(names(O2), ['Katsura', 'Ryota'])
    assert.equal(O2.data().sessions.length, O1.data().sessions.length)
    assert.equal((await server(ws, `collection = 'members'`)).length, 2)
    assert.equal((await server(ws, `collection = 'members'`)).find((r) => r.id === ryotaId).data.name, 'Ryota', '人の名前を上書きしない')
  })

  await check('同期を止めていた端末をつなぎ直しても、古い内容で、ほかの人が直した記録を上書きしない', async () => {
    await syncAll(O1)
    O1.sync.unlink()
    assert.equal(O1.st().workspaceId, undefined)
    // 止めているあいだに：指導者がサーバーの記録を直す。管理者の端末では、新しい記録を1件入れ、同じ記録を古い内容のまま持っている
    C.actions.saveSession({ ...C.data().sessions.find((x) => x.id === 's-k1'), memo: 'newer from coach' })
    await syncAll(C)
    O1.actions.saveSession(session('s-o-new', { date: '2026-11-30', memo: 'made while paused' }))
    assert.equal(O1.data().sessions.find((x) => x.id === 's-k1').memo, 'coach entered')
    const before = (await server(ws, `id = 's-k1'`))[0].updated_by
    await O1.sync.resumeWorkspace(plain(await O1.sync.myWorkspaces())[0])
    const [k1] = await server(ws, `id = 's-k1'`)
    assert.deepEqual([k1.data.memo, k1.updated_by], ['newer from coach', before], 'サーバーの新しい内容が残る（送り直さない）')
    assert.equal(O1.data().sessions.find((x) => x.id === 's-k1').memo, 'newer from coach', '端末には新しい内容が届く')
    assert.equal((await server(ws, `id = 's-o-new'`))[0]?.data.memo, 'made while paused', '止めているあいだに入れた記録は届く')
    assert.deepEqual(names(O1), ['Katsura', 'Ryota'])
    assert.equal((await server(ws, `collection = 'profile'`))[0].updated_by, uO.id)
  })

  await check('本人の2台目：コードなしでつなぎ直すと、自分の記録だけが届く', async () => {
    const K2 = makeDevice(uK)
    const mine = plain(await K2.sync.myWorkspaces())
    assert.deepEqual(mine.map((w) => `${w.role}/${w.member_id}`), [`client/${kat.id}`])
    await K2.sync.resumeWorkspace(mine[0])
    assert.deepEqual(K2.data().members.map((m) => m.name), ['Katsura'])
    assert.ok(K2.data().sessions.length > 0 && K2.data().sessions.every((s) => s.memberId === kat.id))
    assert.deepEqual(ids(K2.data().bodies), ['b-k2', 'b-k3', `hb:${kat.id}:2026-11-22`])
  })

  await check('管理者が本人を外すと、その人の記録はグループから見えなくなる。本人の端末には、指導者が入れた分まで届いて残る', async () => {
    // 外す前に、指導者が本人の記録を1件入れ、別の1件を直しておく（本人の端末には、まだ届いていない）
    C.actions.setActiveMember(kat.id)
    C.actions.saveSession(session('s-c-late', { date: '2026-11-29', memo: 'entered just before removal' }))
    C.actions.saveSession({ ...C.data().sessions.find((x) => x.id === 's-k-ok'), memo: 'coach fixed' })
    await syncAll(C)
    // 本人の端末には、まだ送っていない変更がある（新しい1件と、すでにある記録の手直し）
    K.actions.saveBody({ id: 'b-k4', date: '2026-11-29', weight: 70.5, memo: '' })
    K.actions.saveSession({ ...K.data().sessions.find((x) => x.id === 's-c1'), memo: 'my unsent edit' })
    // 管理者の端末にも、その人の記録の手直しが、まだ送られずに残っている
    O1.actions.saveSession({ ...O1.data().sessions.find((x) => x.id === 's-k-own'), memo: 'owner last edit' })
    await tick()

    await O1.sync.removePerson(uK.id)
    await syncAll(K)
    assert.equal(K.st().workspaceId, undefined)
    assert.match(K.st().notice ?? '', /外れたため、同期を止めました。あなたの記録は、この端末に残っています/)
    assert.equal(K.data().sessions.find((x) => x.id === 's-k-own')?.memo, 'owner last edit', '外す側の端末でまだ送っていなかった手直しも、外す前に届けてから預かる')
    // 外れたと分かったときに、グループが預かった自分の記録を受け取っている
    assert.equal(K.data().sessions.find((x) => x.id === 's-c-late')?.memo, 'entered just before removal', '指導者が入れて、まだ届いていなかった記録が届く')
    assert.equal(K.data().sessions.find((x) => x.id === 's-k-ok')?.memo, 'coach fixed', '指導者が直した内容が届く')
    assert.equal(K.data().sessions.find((x) => x.id === 's-c1')?.memo, 'my unsent edit', 'まだ送っていなかった手元の変更は、上書きしない')
    assert.ok(K.data().bodies.some((x) => x.id === 'b-k4') && K.data().sessions.some((x) => x.id === 's-k-own'))
    assert.ok(K.data().sessions.every((x) => x.memberId === kat.id))
    // グループの側には残らない
    assert.equal((await server(ws, `id = 'b-k4'`)).length, 0, '外れたあとの記録は、グループに届かない')
    assert.equal(await liveOf(ws, kat.id), 0, 'その人の記録は、グループから見えなくなる')
    assert.ok(await heldCount(ws, uK) > 0, '本人が答えるまで、預かる')
    assert.deepEqual(plain(await K.sync.myWorkspaces()), [])
    const [h] = plain(await K.sync.myHandovers())
    assert.deepEqual([h.workspace_name, h.member_id, h.member_name, h.records], ['PhysLog', kat.id, 'Katsura', await heldCount(ws, uK)])
    await syncAll(O1, C)
    for (const dev of [O1, C]) {
      assert.ok(![...dev.data().sessions, ...dev.data().bodies, ...dev.data().conditions].some((x) => x.memberId === kat.id), '管理者・指導者の端末からも消える')
      assert.ok(dev.data().members.some((m) => m.id === kat.id), '人（名前）は残る')
      assert.ok(dev.data().sessions.some((x) => x.id === 's-r1'), 'ほかの人の記録は消えない')
    }
    assert.deepEqual(await departed(O1), ['Katsura/pending'])
    assert.deepEqual(await departed(C), ['Katsura/pending'], '指導者にも、返事待ちと分かる')
    assert.deepEqual(plain(await K.sync.listDeparted()), [], '外れた本人には、離れた人の一覧は出ない')
  })

  await check('外した人を同じ人としてもう一度招くと、預かっていた記録がグループに戻り、同じ端末で続きから同期できる', async () => {
    const inv = await O1.sync.createInvite('client', kat.id)
    await K.sync.joinWorkspace(inv.code)
    assert.equal(K.st().role, 'client')
    assert.deepEqual(plain(await K.sync.myHandovers()), [], '入り直したら、返事待ちは消える')
    assert.equal(await heldCount(ws, uK), 0)
    assert.equal((await server(ws, `id = 'b-k4'`))[0]?.member_id, kat.id, '外れているあいだに入れた記録も届く')
    assert.equal(K.st().rejected, 1, '断られるのは、他人の記録とIDがぶつかる1件だけ（端末に残っているので、つなぎ直すとまた数えられる）')
    await syncAll(O1, C)
    for (const dev of [O1, C]) assert.ok(['s-k-own', 's-c-late', 's-k-ok', 's-c1'].every((id) => dev.data().sessions.some((x) => x.id === id)), '管理者・指導者の端末に、その人の記録が戻る')
    assert.equal(O1.data().sessions.find((x) => x.id === 's-k-ok')?.memo, 'coach fixed', '戻るのは、外される直前の中身')
    assert.deepEqual(await departed(O1), [])
  })

  // ───── 指導者が本人を招く／抜けるときに、記録を実績として渡すかを本人が選ぶ／1000件を超える受け取り ─────
  const uD = await makeUser('dai')
  const D = makeDevice(uD)
  let dai
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `c-${String(i).padStart(4, '0')}`, memberId: 'me', date: '2026-10-01', sleep: 7, memo: '' }))

  await check('指導者も、本人を招ける（指導者は招けない）。アカウントが結びつき済みの人は招けない', async () => {
    dai = C.actions.addMember('Dai', false)
    const inv = await C.sync.createInvite('client', dai.id) // 先に同期して、人をサーバーへ送ってから作る
    assert.match(inv.code, /^[2-9A-HJ-NP-Z]{10}$/)
    await assert.rejects(C.sync.createInvite('coach'), /管理者だけ/)
    assert.deepEqual(plain(await C.sync.linkedMemberIds()), [kat.id])
    assert.deepEqual(plain(await C.sync.listInvites()).map((i) => i.member_id), [dai.id], '指導者に見える招待は、自分が作ったものだけ')
    await assert.rejects(C.sync.createInvite('client', kat.id), /すでに別のアカウント/)
    // 招かれた本人の端末。参加する前から、自分の記録が1100件ある
    D.actions.upsertMany('conditions', many(1100))
    const info = plain(await D.sync.inviteInfo(inv.code))
    assert.deepEqual([info.role, info.member_name], ['client', 'Dai'])
    await D.sync.joinWorkspace(inv.code)
    assert.equal(D.st().role, 'client')
    assert.deepEqual(D.st().outbox, [])
    assert.equal(await count(`workspace_id = $1 and member_id = $2 and collection = 'conditions' and not deleted`, [ws, dai.id]), 1100)
    assert.deepEqual(plain(await C.sync.linkedMemberIds()).sort(), [dai.id, kat.id].sort())
  })

  await check('1000件を超える記録でも、取りこぼしなく届く（同じ時刻の記録が、1000件の境目にあっても）', async () => {
    await syncAll(O1, C)
    for (const dev of [O1, C]) assert.equal(dev.data().conditions.filter((x) => x.memberId === dai.id).length, 1100)
    assert.equal(plain(O1.st().cursorAt).length, 2, '続きは (コレクション, ID) まで覚える')
  })

  await check('本人が「渡さずに抜ける」と、グループと、管理者・指導者の端末から消える。本人の端末には残る', async () => {
    await D.sync.leaveWorkspace(false)
    assert.equal(D.st().workspaceId, undefined)
    assert.equal(D.data().conditions.length, 1100, '本人の端末の記録は残る')
    assert.equal(await count(`workspace_id = $1 and member_id = $2 and collection = 'conditions' and not deleted`, [ws, dai.id]), 0)
    assert.equal(await count(`workspace_id = $1 and member_id = $2 and collection = 'conditions' and deleted and data is null`, [ws, dai.id]), 1100)
    await syncAll(O1, C)
    for (const dev of [O1, C]) {
      assert.equal(dev.data().conditions.filter((x) => x.memberId === dai.id).length, 0, '1100件の削除が、すべて届く')
      assert.ok(dev.data().members.some((m) => m.id === dai.id), '人（名前）は残る')
    }
    assert.ok(O1.data().sessions.some((x) => x.id === 's-k-own'), 'ほかの人の記録は消えない')
    assert.deepEqual(plain(await D.sync.myWorkspaces()), [])
    assert.deepEqual(plain(await D.sync.myHandovers()), [], '自分で選んで抜けたので、あとから聞かれない')
    assert.deepEqual(await departed(O1), ['Dai/declined'])
  })

  await check('渡さずに抜けた本人が、招待コードで入り直すと、端末に残っている記録を預け直せる', async () => {
    const inv = await O1.sync.createInvite('client', dai.id)
    await D.sync.joinWorkspace(inv.code)
    assert.equal(D.data().conditions.length, 1100, '入り直しても、端末の記録は消えない')
    assert.deepEqual(D.st().outbox, [])
    assert.equal(await count(`workspace_id = $1 and member_id = $2 and collection = 'conditions' and not deleted`, [ws, dai.id]), 1100)
    await syncAll(O1)
    assert.equal(O1.data().conditions.filter((x) => x.memberId === dai.id).length, 1100)
  })

  await check('本人が「実績として渡して抜ける」と、まだ送っていない記録も届けてから抜け、記録はグループに残る', async () => {
    K.actions.saveBody({ id: 'b-k9', date: '2026-12-01', weight: 70, memo: '' }) // 同期する前に抜ける
    await tick()
    await K.sync.leaveWorkspace(true)
    assert.equal(K.st().workspaceId, undefined)
    assert.ok(K.data().bodies.some((x) => x.id === 'b-k9'), '本人の端末の記録は残る')
    const [b9] = await server(ws, `id = 'b-k9'`)
    assert.deepEqual([b9?.member_id, b9?.deleted], [kat.id, false])
    await syncAll(O1)
    assert.ok(O1.data().bodies.some((x) => x.id === 'b-k9') && O1.data().sessions.some((x) => x.id === 's-k-own'), '管理者の端末にも残る')
    assert.deepEqual(plain(await O1.sync.linkedMemberIds()), [dai.id])
    assert.deepEqual(await departed(O1), ['Katsura/given'], '実績として渡した、と管理者に分かる')
  })

  // ───── 指導者を外すとき、相手の端末の記録を残すか消すかを、外す側（残る側）が選ぶ ─────
  await check('管理者が指導者を「消して外す」と、相手の端末からグループの記録が消える。参加前から持っていた人の記録は残る', async () => {
    const uE = await makeUser('coach2')
    const E = makeDevice(uE)
    // 参加する前から、この端末にあった記録（自分の分と、自分が見ている別の人の分）
    E.actions.renameMember('me', 'Emi')
    const pal = E.actions.addMember('Pal', false)
    E.actions.saveSession(session('s-e-own', { memo: 'my own' }))
    E.actions.saveSession(session('s-e-pal', { memberId: pal.id, memo: 'pal' }))
    await E.sync.joinWorkspace((await O1.sync.createInvite('coach')).code)
    assert.deepEqual(names(E), ['Dai', 'Emi', 'Katsura', 'Pal', 'Ryota'])
    const ofDai = () => E.data().conditions.filter((x) => x.memberId === dai.id).length
    assert.ok(E.data().sessions.some((x) => x.id === 's-k-own'), 'グループの記録が届いている')
    assert.equal(ofDai(), 1100)
    // グループの仕事として、この端末でグループの人の記録を足す
    E.actions.setActiveMember(kat.id)
    E.actions.saveSession(session('s-e-forK', { date: '2026-12-02', memo: 'by E' }))
    await syncAll(E)

    await O1.sync.removePerson(uE.id, true)
    await syncAll(E)
    assert.equal(E.st().workspaceId, undefined)
    assert.match(E.st().notice ?? '', /この端末にあったグループの記録を消しました/)
    assert.deepEqual(names(E), ['Emi', 'Pal'], '人は、持ち込んだ人だけが残る')
    assert.deepEqual(ids(E.data().sessions), ['s-e-own', 's-e-pal'], '記録は、持ち込んだ人の分だけが残る')
    assert.deepEqual([E.data().conditions.length, E.data().bodies.length], [0, 0])
    assert.deepEqual(E.data().profile, { name: '', sport: '' })
    assert.ok(E.data().members.some((m) => m.id === E.data().activeMemberId), '選択中の人は、残っている人になる')
    // グループには、すべて残っている
    assert.equal(await count(`workspace_id = $1 and id in ('s-e-own', 's-e-pal', 's-e-forK') and not deleted`, [ws]), 3)
    await syncAll(O1)
    assert.ok(['s-e-own', 's-e-pal', 's-e-forK', 's-k-own'].every((id) => O1.data().sessions.some((x) => x.id === id)))

    // 入り直すと、また全部届く
    await E.sync.joinWorkspace((await O1.sync.createInvite('coach')).code)
    assert.ok(E.data().sessions.some((x) => x.id === 's-k-own') && E.data().sessions.some((x) => x.id === 's-e-forK'))
    assert.equal(ofDai(), 1100)

    // 「残して外す」なら、相手の端末の記録はそのまま
    await O1.sync.removePerson(uE.id, false)
    await syncAll(E)
    assert.equal(E.st().workspaceId, undefined)
    assert.match(E.st().notice ?? '', /この端末の記録は、そのまま残っています/)
    assert.ok(E.data().sessions.some((x) => x.id === 's-k-own'))
    assert.equal(ofDai(), 1100)

    // もう一度入ってから「消して外す」。最初に持ち込んだ人の控えは、入り直しても残っている
    await E.sync.joinWorkspace((await O1.sync.createInvite('coach')).code)
    await O1.sync.removePerson(uE.id, true)
    // 外した側の選択を聞けなかったとき（通信の失敗）は、何も消さず、同期もつないだままにして、次でやり直す
    E.fake.failOnce.add('my_departure')
    await assert.rejects(E.sync.syncNow(), /Failed to fetch/)
    assert.equal(E.st().workspaceId, ws)
    assert.equal(ofDai(), 1100)
    await syncAll(E)
    assert.equal(E.st().workspaceId, undefined)
    assert.deepEqual(names(E), ['Emi', 'Pal'])
    assert.deepEqual(ids(E.data().sessions), ['s-e-own', 's-e-pal'])
    assert.equal(E.data().conditions.length, 0)
  })

  // ───── 管理者に外された本人が、記録を実績として渡すかどうかを答える ─────
  const daiConditions = (dev) => dev.data().conditions.filter((x) => x.memberId === dai.id).length

  await check('外された本人が「実績として渡す」と答えるまで、グループには戻らない（指導者の端末が古い写しを送っても）。答えると戻る', async () => {
    // 指導者が、本人（Dai）の記録を入れておく。本人の端末には、まだ届いていない（どちらも、預かりの1000件より後ろに並ぶ）
    C.actions.upsertMany('conditions', [{ id: 'c-zzzz', memberId: dai.id, date: '2026-12-03', sleep: 8, memo: 'by coach' }])
    C.actions.saveSession(session('s-c-forD', { memberId: dai.id, date: '2026-12-03', memo: 'by coach' }))
    await syncAll(C, O1)
    // 指導者の端末には、まだ送っていない手直しがある（電波がなかった、という想定）
    C.actions.upsertMany('conditions', [{ ...C.data().conditions.find((x) => x.id === 'c-0001'), memo: 'offline edit' }])
    await tick()

    await O1.sync.removePerson(uD.id, true) // 「端末の記録も消す」は、本人には効かない
    await syncAll(D)
    assert.equal(D.st().workspaceId, undefined)
    assert.match(D.st().notice ?? '', /あなたの記録は、この端末に残っています/)
    assert.equal(D.data().conditions.length, 1101, '1000件を超える預かりも、最後まで受け取る')
    assert.equal(D.data().conditions.find((x) => x.id === 'c-zzzz')?.memo, 'by coach')
    assert.equal(D.data().sessions.find((x) => x.id === 's-c-forD')?.memo, 'by coach')
    assert.equal(await liveOf(ws, dai.id), 0)
    const [h] = plain(await D.sync.myHandovers())
    assert.deepEqual([h.member_name, h.records], ['Dai', 1102])
    await assert.rejects(D.sync.joinWorkspace((await O1.sync.createInvite('coach')).code), /返事が残っています/, '返事の前は、別の役割では入り直せない')

    // 指導者の端末：古い写しは断られ、グループに戻らない。その端末からも消える
    await syncAll(C)
    assert.equal(C.st().rejected, 1)
    assert.deepEqual(C.st().outbox, [])
    assert.equal(daiConditions(C), 0)
    assert.ok(!C.data().sessions.some((x) => x.memberId === dai.id))
    assert.equal(await count(`workspace_id = $1 and id = 'c-0001' and deleted and data is null`, [ws]), 1)
    assert.ok(C.data().sessions.some((x) => x.id === 's-r1'), 'ほかの人の記録は、受け取り直しても残る')
    await syncAll(O1)
    assert.equal(daiConditions(O1), 0)
    assert.deepEqual(await departed(O1), ['Dai/pending', 'Katsura/given'])

    await D.sync.resolveHandover(h, true)
    assert.deepEqual(plain(await D.sync.myHandovers()), [])
    assert.equal(await heldCount(ws, uD), 0)
    assert.equal(await liveOf(ws, dai.id), 1102)
    await syncAll(O1, C)
    for (const dev of [O1, C]) assert.equal(daiConditions(dev), 1101, '渡された記録が、管理者・指導者の端末に戻る')
    assert.equal(O1.data().conditions.find((x) => x.id === 'c-0001')?.memo, '', '戻るのは、外される直前の中身（断られた古い写しではない）')
    assert.equal(D.data().conditions.length, 1101, '本人の端末の記録は変わらない')
    assert.deepEqual(await departed(O1), ['Dai/given', 'Katsura/given'])
    await assert.rejects(D.sync.resolveHandover(h, false), /すでに答えた/, '答えは、あとから変えられない')
    assert.equal(await liveOf(ws, dai.id), 1102)
  })

  await check('同期を止めていた端末でも、答える前に、その端末に無い記録を受け取る。「渡さない」と答えると、グループからは消えたまま', async () => {
    await D.sync.joinWorkspace((await O1.sync.createInvite('client', dai.id)).code)
    assert.deepEqual(await departed(O1), ['Katsura/given'], '入り直した人は、離れた人の一覧から消える')
    D.sync.unlink() // 本人が、この端末の同期を止めている
    D.actions.upsertMany('conditions', [{ ...D.data().conditions.find((x) => x.id === 'c-0002'), memo: 'mine, while paused' }])
    // そのあいだに、指導者が1件入れ、1件を直す
    C.actions.saveSession(session('s-c-forD2', { memberId: dai.id, date: '2026-12-04', memo: 'while paused' }))
    C.actions.upsertMany('conditions', [{ ...C.data().conditions.find((x) => x.id === 'c-0002'), memo: 'coach version' }])
    await syncAll(C)

    await O1.sync.removePerson(uD.id)
    await syncAll(D) // つながっていないので、何も起きない
    assert.ok(!D.data().sessions.some((x) => x.id === 's-c-forD2'))
    const [h] = plain(await D.sync.myHandovers())
    assert.equal(h.records, 1103)

    await D.sync.resolveHandover(h, false)
    assert.equal(D.data().sessions.find((x) => x.id === 's-c-forD2')?.memo, 'while paused', 'この端末に無かった記録は、答える前に届く')
    assert.equal(D.data().conditions.find((x) => x.id === 'c-0002')?.memo, 'mine, while paused', 'この端末にある記録は、上書きしない')
    assert.equal(D.data().conditions.length, 1101)
    assert.deepEqual([await liveOf(ws, dai.id), await heldCount(ws, uD)], [0, 0], 'グループからは消えたまま。預かりも消える')
    assert.deepEqual(plain(await D.sync.myHandovers()), [])
    await syncAll(O1, C)
    for (const dev of [O1, C]) {
      assert.equal(daiConditions(dev), 0)
      assert.ok(!dev.data().sessions.some((x) => x.memberId === dai.id))
      assert.ok(dev.data().members.some((m) => m.id === dai.id), '人（名前）は残る')
    }
    assert.deepEqual(await departed(O1), ['Dai/declined', 'Katsura/given'])
    // 渡さなかった記録は、管理者が同じIDで入れ直そうとしても、グループに戻らない
    O1.actions.upsertMany('conditions', [{ id: 'c-0003', memberId: dai.id, date: '2026-10-01', sleep: 7, memo: 'put back by owner' }])
    await syncAll(O1)
    assert.equal(O1.st().rejected, 1)
    assert.equal(await liveOf(ws, dai.id), 0)
    assert.equal(daiConditions(O1), 0, '断られた記録は、管理者の端末からも消える')
  })

  await check('まだ同期したことのない別の端末で答えたときは、その端末には何も入れない。同期していた端末の記録は、そのまま残る', async () => {
    const uG = await makeUser('gen')
    const gen = O1.actions.addMember('Gen', false)
    const G1 = makeDevice(uG)
    G1.actions.saveSession(session('s-g-own', { memo: 'mine' }))
    await G1.sync.joinWorkspace((await O1.sync.createInvite('client', gen.id)).code)
    await O1.sync.removePerson(uG.id)
    const G2 = makeDevice(uG) // 同じ人の、同期したことのない端末
    const [h] = plain(await G2.sync.myHandovers())
    assert.deepEqual([h.member_name, h.records], ['Gen', 1])
    await G2.sync.resolveHandover(h, false)
    assert.deepEqual([G2.data().sessions.length, names(G2)], [0, ['自分']], '入れる先の人がいない端末には、何も入れない')
    // 同期していた端末は、次の同期で、外れたと分かる。記録はそのまま残り、もう聞かれない
    await syncAll(G1)
    assert.equal(G1.st().workspaceId, undefined)
    assert.match(G1.st().notice ?? '', /この端末の記録は、そのまま残っています/)
    assert.deepEqual(ids(G1.data().sessions), ['s-g-own'])
    assert.deepEqual(plain(await G1.sync.myHandovers()), [])
    assert.equal(await liveOf(ws, gen.id), 0)
  })

  // ───── 指導者が自分から抜ける ─────
  await check('指導者が自分から抜けると、まだ送っていない記録を届けてから抜け、その端末からグループの記録が消える', async () => {
    C.actions.saveSession(session('s-c-last', { memberId: ryotaId, date: '2026-12-05', memo: 'not yet sent' }))
    await tick()
    await C.sync.leaveWorkspace()
    assert.equal(C.st().workspaceId, undefined)
    assert.match(C.st().notice ?? '', /から抜けました。この端末にあったグループの記録を消しました/)
    assert.deepEqual(plain(await C.sync.myWorkspaces()), [])
    assert.deepEqual(names(C), ['自分'], 'この端末が持ち込んだ人はいないので、最初の状態に戻る')
    assert.deepEqual([C.data().sessions.length, C.data().conditions.length, C.data().bodies.length], [0, 0, 0])
    assert.deepEqual(C.data().profile, { name: '', sport: '' })
    assert.equal((await server(ws, `id = 's-c-last'`))[0]?.data.memo, 'not yet sent', '抜ける前に、グループへ届いている')
    await syncAll(O1)
    assert.ok(['s-c-last', 's-r1', 's-c1'].every((id) => O1.data().sessions.some((x) => x.id === id)), 'グループの記録は変わらない')
    assert.deepEqual(await departed(O1), ['Gen/declined', 'Dai/declined', 'Katsura/given'], '離れた本人の一覧に、指導者は出ない')
  })

  await check('指導者が抜けると、その人の別の端末からもグループの記録が消える。参加する前から持っていた人の記録は残る', async () => {
    const uF = await makeUser('coach3')
    const F = makeDevice(uF)
    F.actions.renameMember('me', 'Fumi')
    F.actions.saveSession(session('s-f-own', { memo: 'mine' }))
    await F.sync.joinWorkspace((await O1.sync.createInvite('coach')).code)
    const F2 = makeDevice(uF) // 同じ人の2台目（何も入っていない端末）
    await F2.sync.resumeWorkspace(plain(await F2.sync.myWorkspaces())[0])
    assert.ok(F2.data().sessions.some((x) => x.id === 's-r1') && F2.data().sessions.some((x) => x.id === 's-f-own'))

    await F.sync.leaveWorkspace()
    assert.deepEqual(names(F), ['Fumi'], '参加する前からこの端末にいた人は残る')
    assert.deepEqual(ids(F.data().sessions), ['s-f-own'])
    // 2台目は、次の同期で、抜けたと分かる
    await syncAll(F2)
    assert.equal(F2.st().workspaceId, undefined)
    assert.match(F2.st().notice ?? '', /この端末にあったグループの記録を消しました/)
    assert.deepEqual([names(F2), F2.data().sessions.length], [['自分'], 0])
    assert.equal(await count(`workspace_id = $1 and id = 's-f-own' and not deleted`, [ws]), 1, 'グループに送った記録は、グループに残る')
  })

  await check('使用済み・でたらめな招待コードは、分かる言葉で断る', async () => {
    const X = makeDevice(uX)
    await assert.rejects(X.sync.joinWorkspace(codeK), /使用済み/)
    await assert.rejects(X.sync.inviteInfo('ZZZZZ-ZZZZZ'), /見つかりません/)
    assert.equal(X.st().workspaceId, undefined)
  })

  await check('前の形の設定（役割なし）が残っている端末は、入っていないグループとの同期を止める', async () => {
    const old = makeDevice(uX, { 'physlog.sync': JSON.stringify({ workspaceId: randomUUID(), workspaceName: 'PhysLog', inviteCode: '3F9A1C2B', outbox: [] }) })
    old.actions.saveSession(session('s-x1'))
    await syncAll(old)
    assert.equal(old.st().workspaceId, undefined)
    assert.match(old.st().notice ?? '', /同期を止めました/)
    assert.ok(old.data().sessions.some((x) => x.id === 's-x1'))
  })

  console.log(`\nすべて通りました（${passed}項目）`)
} catch (e) {
  console.error(`\n失敗：${passed}項目のあとで止まりました`)
  console.error(e)
  process.exitCode = 1
} finally {
  await admin('truncate public.invites, public.records, public.workspace_members, public.workspaces, auth.users cascade').catch(() => {})
  await pool.end()
}
