// ジムの重量の候補と、体組成の取り込み（CSV・写真の文字）のテスト（データベースは使わない）
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'

process.env.TZ = 'Asia/Tokyo'
const load = async (file, extra = {}) => {
  const out = await build({ entryPoints: [new URL(file, import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'neutral', external: ['react', '@capacitor/core'] })
  const store = new Map()
  const ctx = {
    module: { exports: {} }, TextDecoder, Date, Math, JSON,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    require: (m) => ({ react: { useSyncExternalStore: () => null }, '@capacitor/core': { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => ({}) } })[m],
    ...extra,
  }
  vm.runInNewContext(out.outputFiles[0].text, ctx)
  return ctx.module.exports
}
const plain = (x) => JSON.parse(JSON.stringify(x))
let passed = 0
const check = async (name, f) => { await f(); passed++; console.log('PASS', name) }

const G = await load('../src/lib/gyms.ts')
const B = await load('../src/lib/bodyImport.ts')

await check('バーベル：1.25kg プレートがあれば 2.5kg 刻み、なければ 5kg 刻み。バーが複数なら両方', () => {
  const a = plain(G.barbellWeights({ barWeights: [20], plateWeights: [1.25, 2.5, 5, 10, 15, 20] }, 40))
  assert.deepEqual(a, [20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40])
  const b = plain(G.barbellWeights({ barWeights: [20], plateWeights: [2.5, 5, 10] }, 40))
  assert.deepEqual(b, [20, 25, 30, 35, 40])
  const c = plain(G.barbellWeights({ barWeights: [20, 15], plateWeights: [2.5] }, 25))
  assert.deepEqual(c, [15, 20, 25])
  assert.equal(G.barbellWeights({ barWeights: [20], plateWeights: [1.25, 2.5, 5, 10, 15, 20] }, 250).includes(62.5), true)
  assert.equal(G.barbellWeights({ barWeights: [20], plateWeights: [2.5, 5] }, 250).includes(62.5), false, '1.25kg がないジムでは 62.5kg は作れない')
})

await check('ダンベル・種目名からの候補・近くの6つ', () => {
  const g = { ...G.GYM_PRESETS[1].make('x') }
  assert.deepEqual(plain(G.dumbbellWeights(g)).slice(0, 4), [2, 4, 6, 8])
  assert.equal(G.weightCandidates('ダンベルプレス', g)[0], 2)
  assert.equal(G.weightCandidates('ベンチプレス', g)[0], 20)
  assert.deepEqual(plain(G.weightCandidates('プランク', g)), [])
  assert.deepEqual(plain(G.weightCandidates('ベンチプレス', null)), [])
  assert.deepEqual(plain(G.nearby([20, 25, 30, 35, 40, 45, 50, 55, 60], 42)), [30, 35, 40, 45, 50, 55])
  assert.deepEqual(plain(G.nearby([20, 25, 30], undefined)), [20, 25, 30])
})

await check('ジムの保存：既定は1つだけ。引き継ぎでは同じ名前を足さない', () => {
  const a = G.GYM_PRESETS[0].make('A'); a.isDefault = true
  G.saveGym(a)
  const b = G.GYM_PRESETS[0].make('B'); b.isDefault = true
  G.saveGym(b)
  assert.deepEqual(plain(G.getGyms()).map((g) => [g.name, g.isDefault]), [['A', false], ['B', true]])
  assert.equal(G.addGyms([{ ...G.GYM_PRESETS[0].make('A') }, { ...G.GYM_PRESETS[0].make('C'), isDefault: true }]), 1)
  assert.deepEqual(plain(G.getGyms()).map((g) => [g.name, g.isDefault]), [['A', false], ['B', true], ['C', false]])
})

await check('CSV：Shift_JIS の読み取り・引用符・見出しの推定（体脂肪量は取り込まない）', () => {
  // 「測定日,体重(kg),体脂肪率(%),体脂肪量(kg),筋肉量(kg)」を Shift_JIS で
  const sjis = Uint8Array.from([0x91,0xaa,0x92,0xe8,0x93,0xfa,0x2c,0x91,0xcc,0x8f,0x64,0x28,0x6b,0x67,0x29,0x2c,0x91,0xcc,0x8e,0x89,0x96,0x62,0x97,0xa6,0x28,0x25,0x29,0x2c,0x91,0xcc,0x8e,0x89,0x96,0x62,0x97,0xca,0x28,0x6b,0x67,0x29,0x2c,0x8b,0xd8,0x93,0xf7,0x97,0xca,0x28,0x6b,0x67,0x29,0x0d,0x0a,
    ...new TextEncoder().encode('2026/10/01 07:30,70.2,15.1,10.6,56.4\r\n"2026/10/02",70,"",,\r\n'), 0x82,0xa0,0x2c,0x2c,0x0d,0x0a])
  const dec = B.decodeCSV(sjis)
  assert.equal(dec.encoding, 'Shift_JIS')
  const rows = B.splitRows(dec.text)
  assert.deepEqual(plain(B.guessMapping(rows[0])), ['date', 'weight', 'bodyFat', 'skip', 'muscle'])
  const built = plain(B.buildRows(rows.slice(1), B.guessMapping(rows[0])))
  assert.deepEqual(built.map((r) => [r.date, r.weight, r.bodyFat, r.muscle]), [['2026-10-01', 70.2, 15.1, 56.4], ['2026-10-02', 70, undefined, undefined]])
  assert.equal(B.decodeCSV(new TextEncoder().encode('﻿date,weight\n20261003,71')).encoding, 'UTF-8')
  assert.deepEqual(plain(B.splitRows('a,"b ""q"" c\nd",e\n\n1,2')), [['a', 'b "q" c\nd', 'e'], ['1', '2']])
  assert.deepEqual(plain(B.guessMapping(['Date', 'Weight', 'Body Fat', 'SMM', 'メモ'])), ['date', 'weight', 'bodyFat', 'muscle', 'skip'])
})

await check('日付と数の読み方（全角・単位つき・いろいろな書式・ありえない日付は読まない）', () => {
  assert.equal(B.parseNumber('６８．５ｋｇ'), 68.5)
  assert.equal(B.parseNumber('—'), undefined)
  for (const [s, d] of [['2026-10-01', '2026-10-01'], ['2026.1.5', '2026-01-05'], ['20261001093000', '2026-10-01'], ['2026年10月1日', '2026-10-01'], ['26/10/01', '2026-10-01'], ['２０２６／１０／０１', '2026-10-01']]) assert.equal(B.parseDate(s), d, s)
  assert.equal(B.parseDate('2026/02/30'), undefined)
  assert.equal(B.firstDate('測定日 2026/07/20 08:15'), '2026-07-20')
})

await check('写真の文字：同じ行・次の行の数値を拾う。体脂肪量・項目名の数字は拾わない。日付がなければ今日', () => {
  const r = plain(B.extractFromLines(['InBody 570', '測定日 2026/07/20', '体重 68.5 kg', '体脂肪量 12.3', '体脂肪率', '18.0 %', '骨格筋量(SMM)', '31.2'], '2026-11-26'))
  assert.deepEqual([r.date, r.weight, r.bodyFat, r.muscle], ['2026-07-20', 68.5, 18, 31.2])
  const t = plain(B.extractFromLines(['体重 70.1'], '2026-11-26'))
  assert.deepEqual([t.date, t.weight], ['2026-11-26', 70.1])
})

await check('保存：同じ人の同じ日は空いている項目だけを埋め、ほかの人の記録には触れない。新しい日は足す', () => {
  let n = 0
  const existing = [
    { id: 'b1', memberId: 'me', date: '2026-10-01', weight: 70, memo: '' },
    { id: 'b2', memberId: 'other', date: '2026-10-02', weight: 50, memo: '' },
  ]
  const rows = [
    { date: '2026-10-01', weight: 71, bodyFat: 15, raw: '' },
    { date: '2026-10-02', weight: 72, raw: '' },
    { date: '2026-10-02', muscle: 30, raw: '' },
    { date: '2026-10-03', raw: '' },
  ]
  const r = plain(B.mergeRows(existing, rows, 'me', () => `n${++n}`, 'CSV'))
  assert.equal(r.added, 1)
  assert.equal(r.merged, 1)
  const b1 = r.items.find((x) => x.id === 'b1')
  assert.deepEqual([b1.weight, b1.bodyFat], [70, 15], '入力済みの体重は上書きしない')
  const nw = r.items.find((x) => x.id === 'n1')
  assert.deepEqual([nw.memberId, nw.date, nw.weight, nw.muscle, nw.memo], ['me', '2026-10-02', 72, 30, 'CSV'], '同じ日の2行は1件にまとめる')
  assert.ok(!r.items.some((x) => x.id === 'b2'))
})

console.log(`\nすべて通りました（${passed}項目）`)
