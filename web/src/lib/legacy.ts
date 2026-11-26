// 旧版（SwiftUI 版 PhysLog）の記録を引き継ぐ。iOS アプリ版の初回起動時に1回だけ動く。
// 読み出しは iOS 側（ios/App/App/LegacyImportPlugin.swift）、新しい形への変換はここ。
// 引き継ぐもの：身体測定・コンディション・能力測定・トレーニング（種目とセット、ジム名→場所）・プロフィール（名前・競技）・
// ジムの器具設定（バー・プレート・ダンベルの重さ。端末ごとの設定に入れる）。
// 引き継がないもの：メニュー作成の設定（目的・経験・日数。新しい版では、その場で選ぶ形のため）。
import { Capacitor, registerPlugin } from '@capacitor/core'
import { addGyms, type Gym, type MachineUnit } from './gyms'
import type { AppData, BodyMeasurement, ConditionRecord, ExerciseLog, PhysicalAbility, SetEntry, TrainingSession } from '../types'

export interface LegacySet { weight?: number; reps?: number; order: number }
export interface LegacyExercise { name: string; order: number; weight?: number; reps?: number; sets?: number; entries: LegacySet[] }
export interface LegacyData {
  found: boolean
  profile?: { name: string; sport: string }
  bodies?: { date: number; weight?: number; bodyFat?: number; muscle?: number; memo: string; fromHealth: boolean }[]
  conditions?: { date: number; sleep?: number; fatigue?: number; condition?: number; memo: string; fromHealth: boolean }[]
  abilities?: { date: number; type: string; value: number; unit: string; memo: string }[]
  sessions?: { date: number; sport: string; memo: string; gym: string; exercises: LegacyExercise[] }[]
  gyms?: {
    name: string; memo: string; isDefault: boolean
    barWeights?: number[]; plateWeights?: number[]; dumbbellMin?: number; dumbbellMax?: number; dumbbellStep?: number
    machineUnit?: string; machineStepWeight?: number
  }[]
}

export interface Converted {
  bodies: BodyMeasurement[]
  conditions: ConditionRecord[]
  abilities: PhysicalAbility[]
  sessions: TrainingSession[]
  profile: { name: string; sport: string }
  gyms: Gym[]
}

/** 端末の時刻での日付（YYYY-MM-DD） */
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T

/** 旧版のセットの持ち方を、1セットずつの並びにする（旧版の resolvedSets と同じ決まり） */
export function toSets(e: LegacyExercise): SetEntry[] {
  const list = [...(e.entries ?? [])].sort((a, b) => a.order - b.order)
  if (list.length) return list.map((x) => clean({ weight: x.weight, reps: x.reps }))
  if (e.weight == null && e.reps == null) return []
  const n = e.sets && e.sets > 0 ? e.sets : 1
  return Array.from({ length: n }, () => clean({ weight: e.weight, reps: e.reps }))
}

/** 旧版の記録を、新しい版の記録にする。memberId は取り込む先の人。id は旧版の記録ごとに決まった値（何度変換しても同じ） */
export function convertLegacy(raw: LegacyData, memberId: string): Converted {
  const seq = new Map<string, number>()
  const idOf = (kind: string, ms: number) => {
    const k = `${kind}:${ms}`
    const n = (seq.get(k) ?? 0) + 1
    seq.set(k, n)
    return `lg-${kind}-${ms}${n > 1 ? `-${n}` : ''}`
  }
  const bodies = (raw.bodies ?? [])
    .filter((b) => b.weight != null || b.bodyFat != null || b.muscle != null || b.memo)
    .map((b) => clean<BodyMeasurement>({
      id: idOf('b', b.date), memberId, date: dayOf(b.date),
      weight: b.weight, bodyFat: b.bodyFat, muscle: b.muscle,
      memo: b.memo || (b.fromHealth ? 'ヘルスケアから取り込み（旧版）' : ''),
    }))
  const conditions = (raw.conditions ?? [])
    .filter((c) => c.sleep != null || c.fatigue != null || c.condition != null || c.memo)
    .map((c) => clean<ConditionRecord>({
      id: idOf('c', c.date), memberId, date: dayOf(c.date),
      sleep: c.sleep, fatigue: c.fatigue, condition: c.condition, memo: c.memo ?? '',
    }))
  const abilities = (raw.abilities ?? [])
    .filter((a) => a.type)
    .map((a) => ({ id: idOf('a', a.date), memberId, date: dayOf(a.date), type: a.type, value: a.value, unit: a.unit, memo: a.memo ?? '' }))
  const sessions = (raw.sessions ?? []).map((s) => {
    const id = idOf('s', s.date)
    const exercises: ExerciseLog[] = [...(s.exercises ?? [])]
      .sort((a, b) => a.order - b.order)
      .filter((e) => e.name)
      .map((e, i) => ({ id: `${id}-e${i + 1}`, name: e.name, sets: toSets(e) }))
    return clean<TrainingSession>({ id, memberId, date: dayOf(s.date), sport: s.sport ?? '', memo: s.memo ?? '', place: s.gym || undefined, exercises })
  })
  const unit = (u?: string): MachineUnit => (u === 'lb' ? 'lb' : u === '段階' ? 'stack' : 'kg')
  const gyms: Gym[] = (raw.gyms ?? []).filter((g) => g.name).map((g, i) => clean<Gym>({
    id: `lg-gym-${i + 1}`, name: g.name, memo: g.memo ?? '', isDefault: !!g.isDefault,
    barWeights: g.barWeights ?? [20], plateWeights: g.plateWeights ?? [1.25, 2.5, 5, 10, 15, 20],
    dumbbellMin: g.dumbbellMin ?? 1, dumbbellMax: g.dumbbellMax ?? 40, dumbbellStep: g.dumbbellStep ?? 2,
    machineUnit: unit(g.machineUnit), machineStepWeight: g.machineStepWeight,
  }))
  return { bodies, conditions, abilities, sessions, gyms, profile: { name: raw.profile?.name ?? '', sport: raw.profile?.sport ?? '' } }
}

const FLAG = 'physlog.legacyImport'
interface LegacyPlugin { read(): Promise<LegacyData> }
const LegacyImport = registerPlugin<LegacyPlugin>('LegacyImport')

/** 引き継いだ件数（すでに済んでいる・旧版の記録がないときは null） */
export interface LegacyResult { total: number }

type Store = {
  getState: () => AppData
  upsertMany: (col: 'bodies' | 'conditions' | 'abilities' | 'sessions', items: never[]) => void
  setProfile: (p: AppData['profile']) => void
  renameMember: (id: string, name: string) => void
}

/** 初回起動時に1回だけ、旧版の記録を引き継ぐ。読めなかったときは、次の起動でやり直す */
export async function importLegacy(store: Store, read: () => Promise<LegacyData> = () => LegacyImport.read()): Promise<LegacyResult | null> {
  try { if (localStorage.getItem(FLAG)) return null } catch { return null }
  let raw: LegacyData
  try { raw = await read() } catch { return null }
  const done = (v: string) => { try { localStorage.setItem(FLAG, v) } catch { /* 無視 */ } }
  if (!raw.found) { done('none'); return null }
  const state = store.getState()
  const memberId = state.activeMemberId
  const c = convertLegacy(raw, memberId)
  store.upsertMany('bodies', c.bodies as never[])
  store.upsertMany('conditions', c.conditions as never[])
  store.upsertMany('abilities', c.abilities as never[])
  store.upsertMany('sessions', c.sessions as never[])
  const gymCount = addGyms(c.gyms)
  // 名前と競技：新しい版でまだ決めていなければ、旧版のものを使う
  if (c.profile.name || c.profile.sport) {
    const p = store.getState().profile
    store.setProfile({ name: p.name || c.profile.name, sport: p.sport || c.profile.sport })
  }
  const me = store.getState().members.find((m) => m.id === memberId)
  if (c.profile.name && me && me.name === '自分') store.renameMember(memberId, c.profile.name)
  done(new Date().toISOString())
  return { total: c.bodies.length + c.conditions.length + c.abilities.length + c.sessions.length + gymCount }
}

/** iOS アプリ版でだけ動かす */
export const canImportLegacy = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
