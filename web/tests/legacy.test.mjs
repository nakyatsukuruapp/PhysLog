// 旧版（SwiftUI 版）の記録の引き継ぎ：変換と取り込みのテスト（データベースは使わない）
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'

process.env.TZ = 'Asia/Tokyo'
const out = await build({
  entryPoints: [new URL('../src/lib/legacy.ts', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'neutral',
  external: ['@capacitor/core', 'react'],
})
const store = new Map()
const ctx = { module: { exports: {} }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  require: (m) => { if (m === 'react') return { useSyncExternalStore: () => null }; if (m === '@capacitor/core') return { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) }; throw new Error(m) } }
ctx.exports = ctx.module.exports
vm.runInNewContext(out.outputFiles[0].text, ctx)
const { convertLegacy, toSets, importLegacy } = ctx.module.exports
const plain = (x) => JSON.parse(JSON.stringify(x))
let passed = 0
const check = async (name, f) => { await f(); passed++; console.log('PASS', name) }

const t = (s) => new Date(s).getTime()
const raw = {
  found: true,
  profile: { name: 'Taro', sport: 'バスケットボール' },
  bodies: [
    { date: t('2026-10-01T23:30:00+09:00'), weight: 70.2, bodyFat: 15.1, memo: '', fromHealth: false },
    { date: t('2026-10-02T07:00:00+09:00'), weight: 70, memo: '', fromHealth: true },
    { date: t('2026-10-03T07:00:00+09:00'), memo: '', fromHealth: false },
  ],
  conditions: [{ date: t('2026-10-01T08:00:00+09:00'), sleep: 7.5, fatigue: 2, condition: 1, memo: 'good', fromHealth: false }],
  abilities: [{ date: t('2026-09-30T10:00:00+09:00'), type: '垂直跳び', value: 62, unit: 'cm', memo: '' }],
  sessions: [{
    date: t('2026-10-01T19:00:00+09:00'), sport: 'ウェイトトレーニング', memo: '脚の日', gym: 'エニタイム',
    exercises: [
      { name: 'スクワット', order: 1, weight: 60, reps: 5, sets: 3, entries: [] },
      { name: 'ベンチプレス', order: 0, entries: [{ order: 1, weight: 50, reps: 8 }, { order: 0, weight: 40, reps: 10 }] },
      { name: 'プランク', order: 2, entries: [] },
      { name: 'カーフレイズ', order: 3, reps: 15, entries: [] },
    ],
  }],
  gyms: [{ name: 'エニタイム', memo: '', isDefault: true, barWeights: [20, 15], plateWeights: [2.5, 5, 10], dumbbellMin: 2, dumbbellMax: 30, dumbbellStep: 2, machineUnit: 'lb' }, { name: '学校', memo: '', isDefault: false }],
}

await check('セットの持ち方：1セットずつの記録・同じ重さの繰り返し・何もない・回数だけ', () => {
  assert.deepEqual(plain(toSets(raw.sessions[0].exercises[1])), [{ weight: 40, reps: 10 }, { weight: 50, reps: 8 }])
  assert.deepEqual(plain(toSets(raw.sessions[0].exercises[0])), [{ weight: 60, reps: 5 }, { weight: 60, reps: 5 }, { weight: 60, reps: 5 }])
  assert.deepEqual(plain(toSets(raw.sessions[0].exercises[2])), [])
  assert.deepEqual(plain(toSets(raw.sessions[0].exercises[3])), [{ reps: 15 }])
})

await check('記録を新しい形にする（端末の時刻の日付・種目の順番・ジム名は場所に・空の測定は落とす）', () => {
  const c = plain(convertLegacy(raw, 'me'))
  assert.deepEqual(c.bodies.map((b) => [b.date, b.weight, b.bodyFat, b.memo]), [['2026-10-01', 70.2, 15.1, ''], ['2026-10-02', 70, undefined, 'ヘルスケアから取り込み（旧版）']])
  assert.deepEqual(c.conditions[0], { id: c.conditions[0].id, memberId: 'me', date: '2026-10-01', sleep: 7.5, fatigue: 2, condition: 1, memo: 'good' })
  assert.deepEqual(c.abilities.map((a) => [a.date, a.type, a.value, a.unit]), [['2026-09-30', '垂直跳び', 62, 'cm']])
  const s = c.sessions[0]
  assert.deepEqual([s.date, s.sport, s.memo, s.place, s.memberId], ['2026-10-01', 'ウェイトトレーニング', '脚の日', 'エニタイム', 'me'])
  assert.deepEqual(s.exercises.map((e) => e.name), ['ベンチプレス', 'スクワット', 'プランク', 'カーフレイズ'])
  assert.equal(new Set(s.exercises.map((e) => e.id)).size, 4)
  assert.deepEqual(c.profile, { name: 'Taro', sport: 'バスケットボール' })
  assert.deepEqual(c.gyms.map((g) => [g.name, g.isDefault, g.barWeights, g.plateWeights, g.dumbbellStep, g.machineUnit]), [['エニタイム', true, [20, 15], [2.5, 5, 10], 2, 'lb'], ['学校', false, [20], [1.25, 2.5, 5, 10, 15, 20], 2, 'kg']])
})

await check('id は何度変換しても同じ。同じ時刻の記録が2件あっても、ぶつからない', () => {
  const twice = { found: true, bodies: [raw.bodies[0], raw.bodies[0]] }
  const a = plain(convertLegacy(twice, 'me')).bodies.map((b) => b.id)
  const b = plain(convertLegacy(twice, 'me')).bodies.map((b) => b.id)
  assert.deepEqual(a, b)
  assert.equal(new Set(a).size, 2)
})

const makeStore = (members = [{ id: 'me', name: '自分' }], profile = { name: '', sport: '' }) => {
  let state = { version: 1, profile, members, activeMemberId: members[0].id, bodies: [], abilities: [], sessions: [], conditions: [], photos: [], activities: [] }
  return {
    get state() { return state },
    getState: () => state,
    upsertMany: (col, items) => { state = { ...state, [col]: [...state[col].filter((x) => !items.some((i) => i.id === x.id)), ...items] } },
    setProfile: (p) => { state = { ...state, profile: p } },
    renameMember: (id, name) => { state = { ...state, members: state.members.map((m) => (m.id === id ? { ...m, name } : m)) } },
  }
}

await check('初回だけ取り込む。名前（自分→旧版の名前）と競技も引き継ぐ。2回目は何もしない', async () => {
  store.clear()
  const s = makeStore()
  const r = await importLegacy(s, async () => raw)
  assert.equal(r.total, 2 + 1 + 1 + 1 + 2, 'ジム2つも数える')
  assert.deepEqual(JSON.parse(store.get('physlog.gyms')).map((g) => g.name), ['エニタイム', '学校'])
  assert.equal(s.state.sessions[0].exercises.length, 4)
  assert.deepEqual(plain(s.state.profile), { name: 'Taro', sport: 'バスケットボール' })
  assert.equal(s.state.members[0].name, 'Taro')
  assert.equal(await importLegacy(s, async () => { throw new Error('呼ばれないはず') }), null)
  assert.equal(s.state.bodies.length, 2)
})

await check('新しい版で決めた名前・競技は上書きしない', async () => {
  store.clear()
  const s = makeStore([{ id: 'm1', name: 'Hanako' }], { name: 'Hanako', sport: 'テニス' })
  await importLegacy(s, async () => raw)
  assert.deepEqual([s.state.profile.name, s.state.profile.sport, s.state.members[0].name], ['Hanako', 'テニス', 'Hanako'])
  assert.ok(s.state.bodies.every((b) => b.memberId === 'm1'), 'いま選んでいる人に取り込む')
})

await check('旧版の記録がなければ、次からは確かめない。読めなかったときは、次の起動でやり直す', async () => {
  store.clear()
  const s = makeStore()
  assert.equal(await importLegacy(s, async () => { throw new Error('開けない') }), null)
  assert.equal(store.get('physlog.legacyImport'), undefined)
  assert.equal(await importLegacy(s, async () => ({ found: false })), null)
  assert.equal(store.get('physlog.legacyImport'), 'none')
  assert.equal(s.state.sessions.length, 0)
})

console.log(`\nすべて通りました（${passed}項目）`)
