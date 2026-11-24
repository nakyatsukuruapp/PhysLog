// 端末のヘルスケア（iPhone: HealthKit / Android: Health Connect）から読み取る。
// アプリ版（Capacitor）でだけ動く。ブラウザ版では isNative() が false になり、何もしない。
//
// 読むもの：睡眠・歩数・歩行距離・サイクリング距離・体重・体脂肪率・ワークアウト
// 書き込みはしない（読み取り専用）。

import { Capacitor } from '@capacitor/core'
import type { HealthDataType, HealthSample, Workout } from '@capgo/capacitor-health'
import { actions, onMemberRemap } from '../store'
import type { Activity, ActivityKind, AppData, BodyMeasurement, ConditionRecord, HealthSync } from '../types'
import { addDays, toKey, todayKey } from './format'

export const READ_TYPES: HealthDataType[] = Capacitor.getPlatform() === 'ios'
  ? ['sleep', 'steps', 'distance', 'distanceCycling', 'weight', 'bodyFat', 'workouts']
  : ['sleep', 'steps', 'distance', 'weight', 'bodyFat', 'workouts']

const KEY = 'physlog.health'
export const loadSync = (): HealthSync => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '') as HealthSync } catch { return { connected: false } }
}
const saveSync = (s: HealthSync) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* 無視 */ } }

// 同期の初回に人のIDが付け替わったら、取り込み先も新しいIDに合わせる（古いIDのままだと、誰のものでもない記録になる）
onMemberRemap((map) => {
  const s = loadSync()
  const to = s.memberId ? map.get(s.memberId) : undefined
  if (to) saveSync({ ...s, memberId: to })
})

export const isNative = () => Capacitor.isNativePlatform()
export const platformName = () => (Capacitor.getPlatform() === 'android' ? 'Health Connect' : 'ヘルスケア')

// プラグインはアプリ版でだけ読み込む（ブラウザ版の1ファイルHTMLを重くしないため）
const plugin = async () => (await import('@capgo/capacitor-health')).Health

export async function availability(): Promise<{ ok: boolean; reason?: string }> {
  if (!isNative()) return { ok: false, reason: 'ブラウザ版では使えません（アプリ版で使えます）' }
  try {
    const r = await (await plugin()).isAvailable()
    return { ok: r.available, reason: r.reason }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}

/** 許可を求める。iOS は「許可したか」を返さない仕様なので、ここでは呼べたかどうかだけを見る */
export async function connect(memberId: string): Promise<HealthSync> {
  const H = await plugin()
  await H.requestAuthorization({ read: READ_TYPES, requestHistoryAccess: true })
  const s: HealthSync = { ...loadSync(), connected: true, memberId }
  saveSync(s)
  return s
}

export function disconnect() {
  saveSync({ connected: false })
}

export async function openSettings() {
  if (Capacitor.getPlatform() === 'android') await (await plugin()).openHealthConnectSettings()
}

// ───────── 変換 ─────────

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dayOf = (iso: string) => toKey(new Date(iso))

/** 重なった区間をまとめて合計（Apple Watch と iPhone の両方が記録した睡眠を二重に数えない） */
function unionMinutes(spans: [number, number][]) {
  const s = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0, cs = -1, ce = -1
  for (const [a, b] of s) {
    if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b } else ce = Math.max(ce, b)
  }
  if (ce > cs) total += ce - cs
  return total / 60000
}

const ASLEEP = new Set(['asleep', 'rem', 'deep', 'light'])

/** 睡眠は「起きた日」の記録にする。前日18時〜当日18時に終わった睡眠をその日分とみなす */
export function summarizeSleep(samples: HealthSample[]) {
  const byDay = new Map<string, HealthSample[]>()
  for (const x of samples) {
    const end = new Date(x.endDate)
    const k = toKey(new Date(end.getTime() + 6 * 3600_000)) // 18時以降に終わった分は翌日扱い
    if (!byDay.has(k)) byDay.set(k, [])
    byDay.get(k)!.push(x)
  }
  const out = new Map<string, { hours: number; bedtime: string; wake: string }>()
  for (const [k, list] of byDay) {
    // 段階（深い・REMなど）が来ていればそれを、なければサンプル自体を使う
    const segs: { s: string; e: string; st: string }[] = []
    for (const x of list) {
      if (x.stages?.length) x.stages.forEach((g) => segs.push({ s: g.startDate, e: g.endDate, st: g.stage }))
      else segs.push({ s: x.startDate, e: x.endDate, st: x.sleepState ?? 'asleep' })
    }
    let use = segs.filter((g) => ASLEEP.has(g.st))
    if (!use.length) use = segs.filter((g) => g.st === 'inBed') // 眠りの段階を出さない機器は「ベッド内」で代用
    if (!use.length) continue
    // 2時間以上あいたら別の睡眠とみなし、いちばん長いかたまり（夜の睡眠）を使う。昼寝は入れない
    const sorted = [...use].sort((a, b) => a.s.localeCompare(b.s))
    const groups: typeof use[] = []
    let lastEnd = -Infinity
    for (const g of sorted) {
      const st = new Date(g.s).getTime()
      if (st - lastEnd > 2 * 3600_000) groups.push([])
      groups[groups.length - 1].push(g)
      lastEnd = Math.max(lastEnd, new Date(g.e).getTime())
    }
    const scored = groups.map((gs) => ({ gs, min: unionMinutes(gs.map((g) => [new Date(g.s).getTime(), new Date(g.e).getTime()] as [number, number])) }))
    const main = scored.reduce((a, b) => (b.min > a.min ? b : a))
    const min = main.min
    if (min < 30) continue // 切れ端だけの日は除く
    const first = main.gs.reduce((a, b) => (a.s < b.s ? a : b))
    const last = main.gs.reduce((a, b) => (a.e > b.e ? a : b))
    out.set(k, { hours: Math.round((min / 60) * 100) / 100, bedtime: hhmm(first.s), wake: hhmm(last.e) })
  }
  return out
}

export function workoutKind(t: Workout['workoutType']): ActivityKind | null {
  if (['walking', 'hiking', 'wheelchairWalkPace'].includes(t)) return 'walk'
  if (['running', 'runningTreadmill', 'trackAndField', 'wheelchairRunPace'].includes(t)) return 'run'
  if (['cycling', 'bikingStationary', 'handCycling'].includes(t)) return 'bike'
  return null
}

// ───────── 取り込み ─────────

export interface SyncResult { sleep: number; days: number; workouts: number; bodies: number }

/** 過去 days 日分を読み、選んだメンバーの記録に入れる。何度実行しても重複しない（IDを固定） */
export async function syncHealth(state: AppData, memberId: string, days = 14): Promise<SyncResult> {
  const H = await plugin()
  const from = addDays(todayKey(), -days)
  const startDate = new Date(from + 'T00:00:00').toISOString()
  const endDate = new Date().toISOString()
  const safe = async <T>(p: Promise<T>, fallback: T) => { try { return await p } catch { return fallback } }

  const [sleepR, stepsR, distR, cycR, weightR, fatR, wR] = await Promise.all([
    // 睡眠は前日の夜から見るため1日多めに読む
    safe(H.readSamples({ dataType: 'sleep', startDate: new Date(addDays(from, -1) + 'T12:00:00').toISOString(), endDate, limit: 2000, ascending: true }), { samples: [] }),
    safe(H.queryAggregated({ dataType: 'steps', startDate, endDate, bucket: 'day', aggregation: 'sum' }), { samples: [] }),
    safe(H.queryAggregated({ dataType: 'distance', startDate, endDate, bucket: 'day', aggregation: 'sum' }), { samples: [] }),
    // Android の distanceCycling は全距離と区別できないため、iOS だけで使う
    Capacitor.getPlatform() === 'ios'
      ? safe(H.queryAggregated({ dataType: 'distanceCycling', startDate, endDate, bucket: 'day', aggregation: 'sum' }), { samples: [] })
      : Promise.resolve({ samples: [] as { startDate: string; value: number }[] }),
    safe(H.readSamples({ dataType: 'weight', startDate, endDate, limit: 500, ascending: true }), { samples: [] }),
    safe(H.readSamples({ dataType: 'bodyFat', startDate, endDate, limit: 500, ascending: true }), { samples: [] }),
    safe(H.queryWorkouts({ startDate, endDate, limit: 300, ascending: true }), { workouts: [] }),
  ])

  const mine = <T extends { memberId?: string; date: string }>(l: T[], d: string) => l.find((x) => (x.memberId ?? 'me') === memberId && x.date === d)

  // 睡眠・歩数 → その日のコンディション
  const sleep = summarizeSleep(sleepR.samples)
  const steps = new Map(stepsR.samples.map((x) => [dayOf(x.startDate), Math.round(x.value)]))
  const dist = new Map(distR.samples.map((x) => [dayOf(x.startDate), Math.round((x.value / 1000) * 100) / 100]))
  const condDays = new Set([...sleep.keys(), ...steps.keys(), ...dist.keys()].filter((d) => d >= from))
  const conds: ConditionRecord[] = []
  for (const d of condDays) {
    const c = mine(state.conditions, d)
    const sl = sleep.get(d)
    conds.push({
      ...(c ?? { id: `hc:${memberId}:${d}`, memo: '' }),
      memberId, date: d,
      // 手で入れた睡眠時間は上書きしない
      sleep: c?.sleep ?? sl?.hours, bedtime: c?.bedtime ?? sl?.bedtime, wake: c?.wake ?? sl?.wake,
      steps: steps.get(d) ?? c?.steps, walkDistance: dist.get(d) ?? c?.walkDistance,
    })
  }
  actions.upsertMany('conditions', conds)

  // ワークアウト → 有酸素（ウォーキング・ラン・バイク）
  const acts: Activity[] = []
  for (const w of wR.workouts) {
    const kind = workoutKind(w.workoutType)
    if (!kind) continue
    const id = `hw:${w.platformId ?? w.startDate}`
    const cur = state.activities.find((x) => x.id === id)
    acts.push({
      ...(cur ?? { memo: w.sourceName ? `${w.sourceName}から取り込み` : '' }),
      id, memberId, date: dayOf(w.startDate), kind, start: hhmm(w.startDate),
      minutes: Math.round(w.duration / 60),
      distance: w.totalDistance ? Math.round((w.totalDistance / 1000) * 100) / 100 : undefined,
    })
  }
  // サイクリング距離だけあってワークアウトがない日（バイクのアプリがワークアウトを書かない場合）
  for (const x of cycR.samples) {
    const d = dayOf(x.startDate)
    if (x.value < 100 || acts.some((a) => a.date === d && a.kind === 'bike')) continue
    acts.push({ id: `hc:bike:${memberId}:${d}`, memberId, date: d, kind: 'bike', distance: Math.round((x.value / 1000) * 100) / 100, memo: 'サイクリング距離（ヘルスケア）' })
  }
  actions.upsertMany('activities', acts)

  // 体重・体脂肪 → 身体測定（その日の最後の値。手入力がある日は空欄だけ埋める）
  const lastOf = (l: HealthSample[]) => { const m = new Map<string, number>(); l.forEach((x) => m.set(dayOf(x.startDate), x.value)); return m }
  const w = lastOf(weightR.samples), f = lastOf(fatR.samples)
  const bodies: BodyMeasurement[] = []
  for (const d of new Set([...w.keys(), ...f.keys()])) {
    const b = mine(state.bodies, d)
    const fat = f.get(d)
    bodies.push({
      ...(b ?? { id: `hb:${memberId}:${d}`, memo: 'ヘルスケアから取り込み' }),
      memberId, date: d,
      weight: b?.weight ?? (w.get(d) != null ? Math.round(w.get(d)! * 10) / 10 : undefined),
      // HealthKit は 0〜1、Health Connect は 0〜100 で返すことがあるのでそろえる
      bodyFat: b?.bodyFat ?? (fat != null ? Math.round((fat <= 1 ? fat * 100 : fat) * 10) / 10 : undefined),
    })
  }
  actions.upsertMany('bodies', bodies)

  saveSync({ ...loadSync(), connected: true, memberId, lastSync: new Date().toISOString() })
  return { sleep: [...sleep.keys()].filter((d) => d >= from).length, days: condDays.size, workouts: acts.length, bodies: bodies.length }
}

/** アプリを開いたときの自動取り込み（1時間に1回まで） */
export async function autoSync(state: AppData): Promise<SyncResult | null> {
  const s = loadSync()
  if (!isNative() || !s.connected || !s.memberId) return null
  if (s.lastSync && Date.now() - new Date(s.lastSync).getTime() < 3600_000) return null
  return syncHealth(state, s.memberId, s.lastSync ? 3 : 30)
}
