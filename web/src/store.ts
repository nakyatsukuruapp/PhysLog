import { useSyncExternalStore } from 'react'
import type { AppData, Member } from './types'
import SEED from './seed.json'

// すべてブラウザの localStorage に保存する（外部送信なし。iOS 版と同じ方針）。
const KEY = 'physlog.v1'
export const DEFAULT_MEMBER = 'me'

const empty = (): AppData => ({
  version: 1,
  profile: { name: '', sport: '' },
  members: [{ id: DEFAULT_MEMBER, name: '自分' }],
  activeMemberId: DEFAULT_MEMBER,
  bodies: [],
  abilities: [],
  sessions: [],
  conditions: [],
  photos: [],
  activities: [],
})

function normalize(d: Partial<AppData>): AppData {
  const base = { ...empty(), ...d, version: 1 as const }
  if (!base.members?.length) base.members = empty().members
  if (!base.members.some((m) => m.id === base.activeMemberId)) base.activeMemberId = base.members[0].id
  return base
}

function load(): AppData {
  try {
    const raw = localStorage.getItem(KEY)
    const base = raw ? normalize(JSON.parse(raw)) : empty()
    // プレビュー版（1ファイル版）だけ、手元の記録を入れた状態で始める。
    // 一度入れた記録は消しても戻らないよう、入れたIDを覚えておく。
    if (import.meta.env.MODE !== 'single') return base
    const SEEDED = KEY + '.seeded'
    const done = new Set<string>(JSON.parse(localStorage.getItem(SEEDED) ?? '[]'))
    const seed = SEED as Partial<AppData>
    const pick = <T extends { id: string }>(l: T[] = []) => l.filter((x) => !done.has(x.id))
    const fresh = { members: seed.members, sessions: pick(seed.sessions), bodies: pick(seed.bodies), abilities: pick(seed.abilities), conditions: pick(seed.conditions), activities: pick(seed.activities) }
    // 既に入れたセッションに後から足した種目は、種目単位で追記する
    // 訂正で差し替えた種目（古いID）は一度だけ取り除く
    const removed = ((SEED as { removedExerciseIds?: string[] }).removedExerciseIds ?? []).filter((id) => !done.has('rm:' + id))
    removed.forEach((id) => done.add('rm:' + id))
    const sessions = base.sessions.map((s0) => {
      const rmMemo = (SEED as { removedMemoLines?: string[] }).removedMemoLines ?? []
      const s = removed.length || rmMemo.some((l) => s0.memo.includes(l))
        ? { ...s0, exercises: s0.exercises.filter((e) => !removed.includes(e.id)), memo: s0.memo.split('\n').filter((l) => !rmMemo.includes(l)).join('\n') }
        : s0
      let src = seed.sessions?.find((x) => x.id === s.id)
      if (!src) return s
      // 後から分かった時刻・場所は、空いていれば入れる
      if ((!s.start && src.start) || (!s.place && src.place)) { s.start ??= src.start; s.end ??= src.end; s.place ??= src.place; src = { ...src } }
      const add = src.exercises.filter((e) => !done.has(e.id) && !s.exercises.some((x) => x.id === e.id))
      const memoLines = src.memo.split('\n').filter((l) => l && !done.has('memo:' + l) && !s.memo.includes(l))
      if (!add.length && !memoLines.length) return s
      return { ...s, exercises: [...s.exercises, ...add], memo: [s.memo, ...memoLines].filter(Boolean).join('\n') }
    })
    ;[fresh.sessions, fresh.bodies, fresh.abilities, fresh.conditions, fresh.activities].forEach((l) => l.forEach((x) => done.add(x.id)))
    seed.sessions?.forEach((x) => {
      x.exercises.forEach((e) => done.add(e.id))
      x.memo.split('\n').filter(Boolean).forEach((l) => done.add('memo:' + l))
    })
    localStorage.setItem(SEEDED, JSON.stringify([...done]))
    return mergeInto({ ...base, sessions }, fresh)
  } catch {
    return empty()
  }
}

const belongs = (memberId: string | undefined, active: string) => (memberId ?? DEFAULT_MEMBER) === active

const mergeList = <T extends { id: string }>(a: T[], b: T[] = []) => {
  const ids = new Set(a.map((x) => x.id))
  return [...a, ...b.filter((x) => !ids.has(x.id))]
}

function mergeInto(state: AppData, d: Partial<AppData>): AppData {
  const members = [...state.members]
  const idMap = new Map<string, string>()
  for (const m of d.members ?? []) {
    const i = members.findIndex((x) => x.id === m.id || x.name === m.name)
    if (i >= 0) {
      idMap.set(m.id, members[i].id)
      // 初期名「自分」のままなら取り込んだ名前を使う
      if (members[i].name === '自分' && m.name) members[i] = { ...members[i], name: m.name }
    } else {
      members.push(m)
      idMap.set(m.id, m.id)
    }
  }
  const remap = <T extends { memberId?: string }>(l: T[] = []) =>
    l.map((x) => ({ ...x, memberId: idMap.get(x.memberId ?? DEFAULT_MEMBER) ?? x.memberId ?? DEFAULT_MEMBER }))
  return {
    ...state,
    members,
    bodies: mergeList(state.bodies, remap(d.bodies)),
    abilities: mergeList(state.abilities, remap(d.abilities)),
    sessions: mergeList(state.sessions, remap(d.sessions)),
    conditions: mergeList(state.conditions, remap(d.conditions)),
    photos: mergeList(state.photos, remap(d.photos)),
    activities: mergeList(state.activities ?? [], remap(d.activities)),
  }
}

let state: AppData = load()
let view: AppData = scope(state)
const listeners = new Set<() => void>()

/** 選択中のメンバーの記録だけに絞った見え方 */
function scope(s: AppData): AppData {
  const a = s.activeMemberId
  return {
    ...s,
    bodies: s.bodies.filter((x) => belongs(x.memberId, a)),
    abilities: s.abilities.filter((x) => belongs(x.memberId, a)),
    sessions: s.sessions.filter((x) => belongs(x.memberId, a)),
    conditions: s.conditions.filter((x) => belongs(x.memberId, a)),
    photos: s.photos.filter((x) => belongs(x.memberId, a)),
    activities: s.activities.filter((x) => belongs(x.memberId, a)),
  }
}

// ───── 同期用：どの記録が変わったかを外（lib/sync.ts）へ知らせる ─────
export const SYNC_COLS = ['members', 'sessions', 'bodies', 'abilities', 'conditions', 'photos', 'activities'] as const
export type SyncCol = (typeof SYNC_COLS)[number] | 'profile'
export interface Change { col: SyncCol; id: string }
let changeListener: ((c: Change[]) => void) | null = null
export const setChangeListener = (f: ((c: Change[]) => void) | null) => { changeListener = f }

// 同期の初回に人のIDを付け替えたとき、IDを覚えているほかの設定（ヘルスケア連携の取り込み先など）へ知らせる
const remapListeners = new Set<(map: Map<string, string>) => void>()
export const onMemberRemap = (f: (map: Map<string, string>) => void) => { remapListeners.add(f); return () => { remapListeners.delete(f) } }

function diff(prev: AppData, next: AppData): Change[] {
  const out: Change[] = []
  for (const col of SYNC_COLS) {
    const a = prev[col] as { id: string }[], b = next[col] as { id: string }[]
    if (a === b) continue
    const am = new Map(a.map((x) => [x.id, x]))
    const bm = new Map(b.map((x) => [x.id, x]))
    for (const [id, x] of bm) { const o = am.get(id); if (o !== x && JSON.stringify(o) !== JSON.stringify(x)) out.push({ col, id }) }
    for (const id of am.keys()) if (!bm.has(id)) out.push({ col, id })
  }
  if (JSON.stringify(prev.profile) !== JSON.stringify(next.profile)) out.push({ col: 'profile', id: 'profile' })
  return out
}

function commit(next: AppData, remote = false) {
  if (!remote && changeListener) {
    const ch = diff(state, next)
    if (ch.length) queueMicrotask(() => changeListener?.(ch))
  }
  state = next
  view = scope(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 容量超過などは無視（画面上のデータは保持される）
  }
  listeners.forEach((l) => l())
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 選択中メンバーの記録 */
export const useData = (): AppData => useSyncExternalStore(subscribe, () => view)
/** 全メンバー分（設定・書き出し用） */
export const useRawData = (): AppData => useSyncExternalStore(subscribe, () => state)

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

type Collection = 'bodies' | 'abilities' | 'sessions' | 'conditions' | 'photos' | 'activities'
type ItemOf<C extends Collection> = AppData[C][number]

function upsert<C extends Collection>(col: C, item: ItemOf<C>) {
  const withMember = { ...item, memberId: item.memberId ?? state.activeMemberId }
  const list = state[col] as ItemOf<C>[]
  const exists = list.some((x) => x.id === item.id)
  const next = exists ? list.map((x) => (x.id === item.id ? withMember : x)) : [...list, withMember]
  commit({ ...state, [col]: next })
}

/** まとめて保存（ヘルスケアの取り込みなど、件数が多いとき用）。memberId は各要素に入れておく */
function upsertMany<C extends Collection>(col: C, items: ItemOf<C>[]) {
  if (!items.length) return
  const list = [...(state[col] as ItemOf<C>[])]
  for (const it of items) {
    const i = list.findIndex((x) => x.id === it.id)
    if (i >= 0) list[i] = it
    else list.push(it)
  }
  commit({ ...state, [col]: list })
}

function remove(col: Collection, id: string) {
  const list = state[col] as { id: string }[]
  commit({ ...state, [col]: list.filter((x) => x.id !== id) })
}

export const actions = {
  saveBody: (b: ItemOf<'bodies'>) => upsert('bodies', b),
  saveAbility: (a: ItemOf<'abilities'>) => upsert('abilities', a),
  saveSession: (s: ItemOf<'sessions'>) => upsert('sessions', s),
  saveCondition: (c: ItemOf<'conditions'>) => upsert('conditions', c),
  savePhoto: (p: ItemOf<'photos'>) => upsert('photos', p),
  saveActivity: (a: ItemOf<'activities'>) => upsert('activities', a),
  upsertMany,
  remove,
  setProfile: (p: AppData['profile']) => commit({ ...state, profile: p }),

  setActiveMember: (id: string) => commit({ ...state, activeMemberId: id }),
  addMember: (name: string, activate = true): Member => {
    const m = { id: uid(), name }
    commit({ ...state, members: [...state.members, m], activeMemberId: activate ? m.id : state.activeMemberId })
    return m
  },
  renameMember: (id: string, name: string) =>
    commit({ ...state, members: state.members.map((m) => (m.id === id ? { ...m, name } : m)) }),
  /** メンバーと、その人の記録をすべて消す */
  deleteMember: (id: string) => {
    if (state.members.length <= 1) return
    const keep = <T extends { memberId?: string }>(l: T[]) => l.filter((x) => (x.memberId ?? DEFAULT_MEMBER) !== id)
    const members = state.members.filter((m) => m.id !== id)
    commit({
      ...state,
      members,
      activeMemberId: state.activeMemberId === id ? members[0].id : state.activeMemberId,
      bodies: keep(state.bodies),
      abilities: keep(state.abilities),
      sessions: keep(state.sessions),
      conditions: keep(state.conditions),
      photos: keep(state.photos),
      activities: keep(state.activities),
    })
  },

  replaceAll: (d: Partial<AppData>) => commit(normalize(d)),
  /** 取り込み。同じIDは上書きしない。メンバーも名前で突き合わせて追加 */
  merge: (d: Partial<AppData>) => commit(mergeInto(state, d)),
  /** 選択中メンバーの記録だけ消す */
  clearActive: () => {
    const a = state.activeMemberId
    const keep = <T extends { memberId?: string }>(l: T[]) => l.filter((x) => !belongs(x.memberId, a))
    commit({ ...state, bodies: keep(state.bodies), abilities: keep(state.abilities), sessions: keep(state.sessions), conditions: keep(state.conditions), photos: keep(state.photos), activities: keep(state.activities) })
  },
  getState: () => state,

  /** 同期：サーバーから来た記録を反映する（送信キューには積まない） */
  applyRemote: (rows: { collection: string; id: string; data: unknown; deleted: boolean }[]) => {
    if (!rows.length) return
    const next: AppData = { ...state }
    for (const r of rows) {
      if (r.collection === 'profile') { if (!r.deleted && r.data) next.profile = r.data as AppData['profile']; continue }
      const col = r.collection as (typeof SYNC_COLS)[number]
      if (!SYNC_COLS.includes(col)) continue
      const list = [...(next[col] as { id: string }[])]
      const i = list.findIndex((x) => x.id === r.id)
      if (r.deleted) { if (i >= 0) list.splice(i, 1) }
      else if (i >= 0) list[i] = r.data as { id: string }
      else list.push(r.data as { id: string })
      ;(next as unknown as Record<string, unknown>)[col] = list
    }
    if (!next.members.length) next.members = empty().members
    if (!next.members.some((m) => m.id === next.activeMemberId)) next.activeMemberId = next.members[0].id
    commit(next, true)
  },

  /** 同期の初回：メンバーIDを付け替える（端末ごとに同じ "me" があるとぶつかるため）。記録の memberId も付け替える */
  remapMembers: (map: Map<string, string>, remoteMembers: Member[] = []) => {
    if (!map.size && !remoteMembers.length) return
    if (map.size) remapListeners.forEach((f) => f(map))
    const re = (id?: string) => { const k = id ?? DEFAULT_MEMBER; return map.get(k) ?? k }
    // ヘルスケアから取り込んだ記録は、IDに「誰の記録か」が入っている（hc:<人>:<日付> など。lib/health.ts）。
    // どの端末でも最初は同じ "me" なので、人のIDを付け替えたら記録のIDも合わせる（別の人の同じ日の記録とぶつからないように）
    const reId = (id: string) => {
      const m = /^(hc:bike|hc|hb):(.+):(\d{4}-\d{2}-\d{2})$/.exec(id)
      const to = m ? map.get(m[2]) : undefined
      return m && to ? `${m[1]}:${to}:${m[3]}` : id
    }
    const fix = <T extends { id: string; memberId?: string }>(l: T[]) => l.map((x) => ({ ...x, id: reId(x.id), memberId: re(x.memberId) }))
    const members: Member[] = []
    for (const m of [...state.members.map((m) => ({ ...m, id: re(m.id) })), ...remoteMembers]) if (!members.some((x) => x.id === m.id)) members.push(m)
    commit({
      ...state,
      members,
      activeMemberId: re(state.activeMemberId),
      bodies: fix(state.bodies), abilities: fix(state.abilities), sessions: fix(state.sessions),
      conditions: fix(state.conditions), photos: fix(state.photos), activities: fix(state.activities),
    }, true)
  },
}
