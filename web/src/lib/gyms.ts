// トレーニング場所（ジム）ごとの器具構成。旧版（SwiftUI 版）の Gym と同じ考え方。
// 同じ「ベンチプレス 60kg」でも、ジムによって作れるかどうかが変わる（バーが 15kg、1.25kg プレートがない、など）。
// 記録画面で、そのジムで作れる重量だけを候補に出すために使う。
// 端末ごとの設定（localStorage）で、同期はしない。
import { useSyncExternalStore } from 'react'

export type MachineUnit = 'kg' | 'lb' | 'stack'
export interface Gym {
  id: string
  name: string
  memo: string
  /** 記録画面で既定として選ばれるジム */
  isDefault: boolean
  /** 置いてあるバーの重さ（kg）。複数種類あれば全部 */
  barWeights: number[]
  /** プレートの刻み（kg）。片側1枚あたり */
  plateWeights: number[]
  dumbbellMin: number
  dumbbellMax: number
  dumbbellStep: number
  /** マシンの重量表記 */
  machineUnit: MachineUnit
  /** 段階表記のとき、1段あたり何kg相当か（分からなければ空） */
  machineStepWeight?: number
}

export const MACHINE_UNIT_LABEL: Record<MachineUnit, string> = { kg: 'キログラム（kg）', lb: 'ポンド（lb）', stack: '段階表記（1番・2番…）' }
export const ALL_PLATES = [0.5, 1, 1.25, 2.5, 5, 10, 15, 20, 25]

const base = (name: string): Gym => ({
  id: `gym-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  name, memo: '', isDefault: false,
  barWeights: [20], plateWeights: [1.25, 2.5, 5, 10, 15, 20],
  dumbbellMin: 1, dumbbellMax: 40, dumbbellStep: 2, machineUnit: 'kg',
})

/** 新しく登録するときの出発点（旧版と同じ4つ） */
export const GYM_PRESETS: { name: string; detail: string; make: (name: string) => Gym }[] = [
  { name: '一般的なジム', detail: '20kgバー / 1.25kgプレートあり / ダンベル1〜40kg', make: (n) => base(n) },
  { name: 'プレートが粗いジム', detail: '20kgバー / 最小2.5kgプレート / ダンベル2kg刻み', make: (n) => ({ ...base(n), plateWeights: [2.5, 5, 10, 15, 20], dumbbellMin: 2, dumbbellStep: 2 }) },
  { name: '軽量バーもあるジム', detail: '20/15/10kgバー / 1.25kgプレートあり', make: (n) => ({ ...base(n), barWeights: [20, 15, 10] }) },
  { name: 'ポンド表記のマシン', detail: 'マシンが lb 表記', make: (n) => ({ ...base(n), machineUnit: 'lb' }) },
]

const round2 = (v: number) => Math.round(v * 100) / 100

/** バーベルで作れる重量。プレートは左右対称に付けるので、片側の合計を2倍してバーに足す */
export function barbellWeights(g: Pick<Gym, 'barWeights' | 'plateWeights'>, maxWeight = 300): number[] {
  if (!g.barWeights.length || !g.plateWeights.length) return []
  const plates = [...g.plateWeights].filter((p) => p > 0).sort((a, b) => a - b)
  const out = new Set<number>()
  for (const bar of g.barWeights) {
    // 片側に載せられるプレートの合計（同じプレートを何枚でも使える）
    const sides = new Set<number>([0])
    let frontier = [0]
    while (frontier.length) {
      const next: number[] = []
      for (const t of frontier) {
        for (const p of plates) {
          const s = round2(t + p)
          if (bar + s * 2 > maxWeight + 1e-9) continue
          if (!sides.has(s)) { sides.add(s); next.push(s) }
        }
      }
      frontier = next
    }
    for (const s of sides) out.add(round2(bar + s * 2))
  }
  return [...out].sort((a, b) => a - b)
}

/** ダンベルの重量の一覧 */
export function dumbbellWeights(g: Pick<Gym, 'dumbbellMin' | 'dumbbellMax' | 'dumbbellStep'>): number[] {
  if (!(g.dumbbellStep > 0) || g.dumbbellMax < g.dumbbellMin) return []
  const out: number[] = []
  for (let w = g.dumbbellMin; w <= g.dumbbellMax + 0.001 && out.length < 500; w += g.dumbbellStep) out.push(round2(w))
  return out
}

/** 種目名から、そのジムで作れる重量の候補を出す（バーベル種目・ダンベル種目だけ。外れても自由に入力できる） */
export function weightCandidates(name: string, g?: Gym | null): number[] {
  if (!g || !name) return []
  if (name.includes('ダンベル') || /dumbbell/i.test(name)) return dumbbellWeights(g)
  const barbell = ['ベンチプレス', 'スクワット', 'デッドリフト', 'ロウ', 'カール', 'プレス', 'クリーン', 'バーベル']
  if (barbell.some((k) => name.includes(k))) return barbellWeights(g, 250)
  return []
}

/** いまの値の近くだけを6つ（全部出すと探すほうが手間になるため） */
export function nearby(all: number[], current?: number, n = 6): number[] {
  if (!all.length) return []
  if (current == null || !(current > 0)) return all.slice(0, n)
  return [...all].sort((a, b) => Math.abs(a - current) - Math.abs(b - current)).slice(0, n).sort((a, b) => a - b)
}

const fmt = (v: number) => String(round2(v))
export function gymSummary(g: Gym): string {
  const parts: string[] = []
  if (g.barWeights.length) parts.push('バー ' + g.barWeights.map((v) => fmt(v) + 'kg').join('/'))
  if (g.plateWeights.length) parts.push(`プレート最小 ${fmt(Math.min(...g.plateWeights))}kg`)
  parts.push(`ダンベル ${fmt(g.dumbbellMin)}〜${fmt(g.dumbbellMax)}kg（${fmt(g.dumbbellStep)}kg刻み）`)
  if (g.machineUnit !== 'kg') parts.push(`マシン ${g.machineUnit === 'lb' ? 'lb' : '段階'}`)
  return parts.join('・')
}

// ───────── 保存（端末ごと） ─────────
const KEY = 'physlog.gyms'
let gyms: Gym[] = load()
const listeners = new Set<() => void>()
function load(): Gym[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function commit(next: Gym[]) {
  gyms = next
  try { localStorage.setItem(KEY, JSON.stringify(gyms)) } catch { /* 無視 */ }
  listeners.forEach((f) => f())
}
export const getGyms = () => gyms
export const useGyms = () => useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, () => gyms)

/** 追加・更新。既定にしたジムがあれば、ほかの既定を外す */
export function saveGym(g: Gym) {
  let list = gyms.some((x) => x.id === g.id) ? gyms.map((x) => (x.id === g.id ? g : x)) : [...gyms, g]
  if (g.isDefault) list = list.map((x) => (x.id === g.id ? x : { ...x, isDefault: false }))
  commit(list)
}
export const removeGym = (id: string) => commit(gyms.filter((x) => x.id !== id))
/** 旧版から引き継いだジムを足す（同じ名前があれば足さない） */
export function addGyms(list: Gym[]) {
  const names = new Set(gyms.map((g) => g.name))
  let hasDefault = gyms.some((g) => g.isDefault)
  const add = list.filter((g) => g.name && !names.has(g.name)).map((g) => {
    const isDefault = g.isDefault && !hasDefault // 既定のジムは1つだけ
    if (isDefault) hasDefault = true
    return { ...g, isDefault }
  })
  if (add.length) commit([...gyms, ...add])
  return add.length
}
export const defaultGym = () => gyms.find((g) => g.isDefault)
