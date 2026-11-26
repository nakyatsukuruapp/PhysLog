// 端末間の同期（Supabase）。iPhone・Android・ブラウザのどれから入れても、同じグループの人に届く。
//
// しくみ
// - 記録を変えると、その記録のIDを「送信待ち」に積む（store の差分検知）
// - 同期のたびに：自分の役割を確かめる → 送信待ちを送る → サーバーで前回より後に変わった記録を受け取る
// - 同じ記録を2台で直したときは、後からサーバーに届いた方が残る
// - 端末の中の記録（localStorage）はそのまま使えるので、電波がなくても記録できる
//
// 役割（グループごと）
// - owner（管理者）・coach（指導者）：グループ全員の記録を読み書きする。本人を招ける（指導者を招く・人を外すのは管理者だけ）
// - client（本人）：自分の記録だけを読み書きする。人（members）と profile は送らない
//
// グループを離れるとき
// - 本人：記録は、指導者の側（グループ）には残さない。本人の端末には残る。
//   本人が「実績として渡す」を選んだときだけ、グループに残す。自分から抜けるときはその場で選び、
//   管理者に外されたときは、次にアプリを開いたときに聞かれる（答えるまで、グループからは見えない）
// - 指導者：自分から抜けると、この端末からグループの記録を消す。管理者が外すときは、消すかどうかを管理者が選ぶ。
//   どちらでも、参加する前からこの端末にあった人の記録は残す
// だれが何を読み書きできるかは、サーバー側（RLS。supabase/migrations）で決まる。
// ここでの絞り込みは、送っても断られるものを最初から送らないためのもの。

import { useSyncExternalStore } from 'react'
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { actions, DEFAULT_MEMBER, setChangeListener, SYNC_COLS, type Change } from '../store'
import { deleteImage } from './photos'
import type { AppData, Member } from '../types'

const URL = 'https://diobubwcrxeikonrhtmf.supabase.co'
// 公開してよい鍵（publishable）。データは、ログインした人が自分の役割で読める分しか読めない（RLS）
const KEY = 'sb_publishable_tg2c5T9Dcc9Q0PseWLhEug_j5H3_zIp'

export type Role = 'owner' | 'coach' | 'client'
export const ROLE_LABEL: Record<Role, string> = { owner: '管理者', coach: '指導者', client: '本人' }

const LS = 'physlog.sync'
export interface SyncState {
  workspaceId?: string
  workspaceName?: string
  role?: Role
  /** client のとき：この利用者が「記録される人」のうち誰か（Member.id） */
  memberId?: string
  /** 受け取りの続き：最後に受け取った記録の更新時刻と、その (コレクション, ID) */
  cursor?: string
  cursorAt?: [string, string]
  lastSync?: string
  outbox: string[]
  linked?: boolean
  /** 権限がなくて送れなかった記録の数 */
  rejected?: number
  /** 同期が止まった理由（グループから外れた、など）。設定画面に出す */
  notice?: string
}
const load = (): SyncState => { try { return { outbox: [], ...JSON.parse(localStorage.getItem(LS) ?? '{}') } } catch { return { outbox: [] } } }
let st: SyncState = load()
const save = () => { try { localStorage.setItem(LS, JSON.stringify(st)) } catch { /* 無視 */ } }

// この端末が、グループにつなぐ前から持っていた人（グループごと）。
// 外れて端末の記録を消すことになったとき、この人たちの記録だけは残す。同期を止めても・外れても、この控えは消さない
const LS_BROUGHT = 'physlog.brought'
const loadBrought = (): Record<string, string[]> => { try { return JSON.parse(localStorage.getItem(LS_BROUGHT) ?? '{}') } catch { return {} } }
function rememberBrought(ws: string, ids: string[]) {
  const all = loadBrought()
  all[ws] = [...new Set([...(all[ws] ?? []), ...ids])]
  try { localStorage.setItem(LS_BROUGHT, JSON.stringify(all)) } catch { /* 無視 */ }
}

let client: SupabaseClient | null = null
export const sb = () => (client ??= createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'physlog.auth' } }))
/** テスト用：Supabase のクライアントを差し替える */
export const __setClient = (c: SupabaseClient | null) => { client = c }

const listeners = new Set<() => void>()
export const onSyncState = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
let snap: SyncState = st
const emit = () => { snap = { ...st }; listeners.forEach((f) => f()) }
export const syncState = () => st
/** 画面用：同期の状態（役割など）が変わると描き直す */
export const useSyncState = (): SyncState => useSyncExternalStore(onSyncState, () => snap)

const key = (col: string, id: string) => `${col}\u0000${id}`
/** 本人（client）が送れるコレクション。サーバー側の権限（RLS）と同じ並び */
type RecordCol = 'sessions' | 'bodies' | 'abilities' | 'conditions' | 'photos' | 'activities'
const RECORD_COLS = new Set<string>(['sessions', 'bodies', 'abilities', 'conditions', 'photos', 'activities'])

/** 本人（client）が送れるのは、自分の記録だけ。削除（data なし）は、持ち主をサーバー側で確かめる */
function sendable(col: string, data: unknown): boolean {
  if (st.role !== 'client') return true
  if (!RECORD_COLS.has(col)) return false
  return data == null || (data as { memberId?: string }).memberId === st.memberId
}

// 記録が変わったら送信待ちに積み、少し待ってから送る
setChangeListener((ch: Change[]) => {
  if (!st.workspaceId) return
  const set = new Set(st.outbox)
  ch.forEach((c) => set.add(key(c.col, c.id)))
  st.outbox = [...set]
  save(); emit()
  schedule()
})
let timer: ReturnType<typeof setTimeout> | undefined
const schedule = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(() => { syncNow().catch(() => {}) }, ms) }

// ───────── サーバーの関数を呼ぶ ─────────

const MESSAGES: [string, string][] = [
  ['invite code not found', '招待コードが見つかりません'],
  ['invite code already used', 'この招待コードは使用済みです'],
  ['invite code expired', 'この招待コードは期限が切れています'],
  ['already a member', 'このグループには、すでに参加しています'],
  ['member already linked', 'この人には、すでに別のアカウントが結びついています'],
  ['member not found', '相手が見つかりません。同期してから、もう一度お試しください'],
  ['member required', '誰の記録かを選んでください'],
  ['owner cannot leave', '管理者は、グループから抜けられません'],
  ['handover pending', 'このグループには、前に外れたときの記録を渡すかどうかの返事が残っています。先に、この画面の上で答えてください'],
  ['nothing to hand over', '返事を待っているグループが見つかりません（すでに答えたか、入り直しています）'],
  ['not allowed', 'この操作は、グループの管理者だけができます'],
  ['not signed in', 'ログインしてください'],
]
const translate = (e: { message: string }) => new Error(MESSAGES.find(([k]) => e.message.includes(k))?.[1] ?? e.message)

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb().rpc(fn, args)
  if (error) throw translate(error)
  return data as T
}

// ───────── ログイン ─────────

export async function session(): Promise<Session | null> {
  return (await sb().auth.getSession()).data.session
}
export async function signUp(email: string, password: string) {
  const { error, data } = await sb().auth.signUp({ email, password })
  if (error) throw error
  return data.session // メール確認が要る設定のときは null
}
export async function signIn(email: string, password: string) {
  const { error } = await sb().auth.signInWithPassword({ email, password })
  if (error) throw error
}
export async function signOut() {
  await sb().auth.signOut()
  st = { outbox: [] }
  save(); emit()
}

/**
 * アカウントを削除する（元に戻せない）。決まり：その人は「unknown user」と表示し、記録はグループに残る。
 * 本人：名簿の名前が「unknown user」になる。管理者：いちばん古くから参加している指導者が管理者を引き継ぐ。
 * この端末の記録は残る。ただし指導者は、グループから抜けたときと同じく、この端末からグループの記録を消す
 */
export async function deleteAccount() {
  const ws = st.workspaceId
  const role = st.role
  // まだ送っていない記録を、先にグループへ届ける（記録は残す決まりのため）
  if (ws) await syncNow().catch(() => {})
  await rpc<null>('delete_my_account')
  if (ws && role === 'coach') wipeGroupRecords(ws)
  // アカウントはもうないので、サーバーには問い合わせず、この端末のログインだけを消す
  await sb().auth.signOut({ scope: 'local' }).catch(() => {})
  st = {
    outbox: [],
    notice: role === 'coach'
      ? 'アカウントを削除しました。この端末にあったグループの記録を消しました（参加する前からこの端末にあった人の記録は残っています）。'
      : 'アカウントを削除しました。この端末の記録は、そのまま残っています。',
  }
  save(); emit()
}

// ───────── グループ（ワークスペース） ─────────

export interface MyWorkspace { id: string; name: string; role: Role; member_id: string | null }
/** 自分が入っているグループと、そこでの役割。別の端末でログインしたときの再接続にも使う */
export const myWorkspaces = async () => (await rpc<MyWorkspace[] | null>('my_workspaces')) ?? []

export async function createWorkspace(name: string) {
  const w = await rpc<{ id: string; name: string }>('create_workspace', { ws_name: name })
  await link({ id: w.id, name: w.name, role: 'owner', member_id: null })
}

export interface InviteInfo { workspace_name: string; role: 'coach' | 'client'; member_name: string | null; already_member: boolean }
/** 招待コードの中身を確かめる（参加する前に、どのグループに・どの役割で入るのかを見せる）。コードは使われない */
export const inviteInfo = (code: string) => rpc<InviteInfo>('invite_info', { code })

export async function joinWorkspace(code: string) {
  const w = await rpc<{ id: string; name: string }>('join_workspace', { code })
  const me = (await myWorkspaces()).find((x) => x.id === w.id)
  if (!me) throw new Error('参加を確かめられませんでした。もう一度お試しください')
  await link(me, true)
}
/** すでに入っているグループを、この端末でも使う */
export const resumeWorkspace = (w: MyWorkspace) => link(w)

/** まだ何も記録していない、入れたばかりの端末か */
function untouched(s: AppData): boolean {
  if (s.members.length !== 1 || s.members[0].id !== DEFAULT_MEMBER || s.members[0].name !== '自分') return false
  return [...RECORD_COLS].every((c) => (s[c as keyof AppData] as unknown[]).length === 0)
}

/**
 * 端末とグループを結びつける。この端末の記録のうち、サーバーにまだないものを送る（本人は自分の分だけ）。
 * joined：招待コードで参加した直後（別の端末でのつなぎ直しではない）
 */
async function link(w: MyWorkspace, joined = false) {
  if (w.role === 'client' && !w.member_id) throw new Error('誰の記録かが決まっていません。管理者に招待をやり直してもらってください')
  st = { workspaceId: w.id, workspaceName: w.name, role: w.role, memberId: w.member_id ?? undefined, outbox: [], linked: false }
  save()
  // 1. サーバーにいる人を読む（本人には、自分の1人だけが見える）
  let remote: Member[], have: Map<string, boolean>
  try {
    const { data: rm, error } = await sb().from('records').select('id,data').eq('workspace_id', w.id).eq('collection', 'members').eq('deleted', false)
    if (error) throw error
    remote = (rm ?? []).map((r) => r.data as Member)
    // サーバーにある記録の一覧（あとで、送るものを決めるのに使う）
    have = await serverKeys(w.id)
  } catch (e) {
    // 結びつける前に失敗したら、元に戻す（「参加中のグループ」からやり直せる）
    st = { outbox: [] }
    save(); emit()
    throw e
  }
  const local = actions.getState()
  const map = new Map<string, string>()
  if (w.role === 'client') {
    // この端末で記録していた人（選択中の人）を、招かれた「自分」に結びつける
    if (!local.members.some((m) => m.id === w.member_id)) map.set(local.activeMemberId, w.member_id!)
  } else {
    const fresh = untouched(local)
    for (const m of local.members) {
      // 名前が同じ人は同じ人としてまとめる
      const same = remote.find((r) => r.name.trim() === m.name.trim())
      if (same) map.set(m.id, same.id)
      // まだ何も記録していない端末の「自分」は、サーバーの最初の人に寄せる（空の人を増やさない）
      else if (fresh && remote.length) map.set(m.id, remote[0].id)
      // 各端末の最初のメンバーは同じID（me）なので、ぶつからないよう付け替える
      else if (m.id === DEFAULT_MEMBER) map.set(m.id, crypto.randomUUID())
    }
  }
  if (w.role !== 'client') {
    const known = new Set(remote.map((m) => m.id))
    rememberBrought(w.id, local.members.map((m) => map.get(m.id) ?? m.id).filter((id) => !known.has(id)))
  }
  actions.remapMembers(map, remote)
  // 人の名前は、サーバーにあるものを正とする
  actions.applyRemote(remote.map((m) => ({ collection: 'members', id: m.id, data: m, deleted: false })))
  if (w.role === 'client') actions.setActiveMember(w.member_id!)
  // 2. この端末の記録のうち、サーバーにまだないものだけを送信待ちに積む。
  //    サーバーにあるものは、このあと受け取る内容を正とする
  //    （同期を止めていたあいだの古い内容で、ほかの人が直した記録を上書きしないため）
  const missing = (k: string) => {
    const deleted = have.get(k)
    if (deleted === undefined) return true
    // 本人が招待コードで入り直したときは、前に「記録を消して抜けた」分を、この端末に残っている記録から預け直す
    return deleted && joined && w.role === 'client'
  }
  const s = actions.getState()
  const all: string[] = []
  for (const col of SYNC_COLS) {
    for (const x of s[col] as { id: string }[]) {
      if (missing(key(col, x.id)) && sendable(col, x)) all.push(key(col, x.id))
    }
  }
  if ((s.profile.name || s.profile.sport) && missing(key('profile', 'profile')) && sendable('profile', s.profile)) all.push(key('profile', 'profile'))
  st.outbox = all
  st.linked = true
  save(); emit()
  await syncNow()
}

/** サーバーにある記録の一覧（自分に見える範囲）。値は、その記録が削除済みかどうか */
async function serverKeys(ws: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb().from('records').select('collection,id,deleted').eq('workspace_id', ws)
      .order('collection', { ascending: true }).order('id', { ascending: true }).range(from, from + 999)
    if (error) throw error
    for (const r of data ?? []) out.set(key(r.collection, r.id), r.deleted)
    if (!data || data.length < 1000) return out
  }
}

/** この端末の同期を止める（グループには入ったまま。記録は端末に残る） */
export function unlink() {
  st = { outbox: [] }
  save(); emit()
}

/** 画面に出した知らせを消す */
export function clearNotice() {
  if (!st.notice) return
  delete st.notice
  save(); emit()
}

// ───────── 招く・外す・抜ける ─────────

export interface Invite { id: string; code: string; role: 'coach' | 'client'; member_id: string | null; expires_at: string }
/**
 * 招待コードを作る。コードは1回きり・期限つきで、この戻り値でしか見られない。
 * 本人（client）の招待は管理者と指導者、指導者（coach）の招待は管理者だけが作れる
 */
export async function createInvite(role: 'coach' | 'client', memberId?: string): Promise<Invite> {
  if (!st.workspaceId) throw new Error('同期を始めてから招待してください')
  // 招く相手（人）がサーバーにいないと招待を作れないので、先に送る（送っている最中に足した分のために、もう一度）
  if (role === 'client') {
    await syncNow()
    if (st.outbox.length) await syncNow()
  }
  return rpc<Invite>('create_invite', { ws: st.workspaceId, invite_role: role, invite_member_id: role === 'client' ? memberId ?? null : null })
}

export interface InviteRow { id: string; role: 'coach' | 'client'; member_id: string | null; created_at: string; expires_at: string; used_at: string | null }
/** 招待の一覧。管理者には全部、指導者には自分が作ったものだけが返る */
export const listInvites = async () => (await rpc<InviteRow[] | null>('list_invites', { ws: st.workspaceId })) ?? []
/** 使われていない招待を取り消す。管理者は全部、指導者は自分が作ったものだけ */
export const revokeInvite = (id: string) => rpc<null>('revoke_invite', { target: id })
/** アカウントが結びついている人（Member.id）。本人を招くとき、まだの人だけを選べるようにする（管理者・指導者） */
export const linkedMemberIds = async () => (await rpc<string[] | null>('linked_member_ids', { ws: st.workspaceId })) ?? []

export interface Person { user_id: string; email: string | null; role: Role; member_id: string | null; joined_at: string }
/** 参加している人の一覧（管理者だけ。メールアドレスつき） */
export const listPeople = async () => (await rpc<Person[] | null>('list_members', { ws: st.workspaceId })) ?? []
/**
 * 指導者・本人をグループから外す（管理者だけ）。
 * 指導者：wipeDevice … その人の端末に残っているグループの記録も消すか（外す側が選ぶ）。相手の端末は、次に同期しようとしたときに消す
 * 本人　：その人の記録は、グループから見えなくなる（本人の端末には残る）。本人が「実績として渡す」と答えたときだけ、グループに戻る
 */
export async function removePerson(userId: string, wipeDevice = false) {
  // 外す前に、この端末でまだ送っていない記録を届ける（本人を外すとき、本人が最後に受け取る記録に入るように）
  await syncNow()
  await rpc<null>('remove_member', { ws: st.workspaceId, target: userId, wipe_device: wipeDevice })
}

export type HandoverState = 'pending' | 'given' | 'declined'
export interface Departed { member_id: string; member_name: string | null; handover: HandoverState; departed_at: string; resolved_at: string | null }
/** グループを離れた本人と、記録を実績として渡したかどうか（管理者・指導者） */
export const listDeparted = async () => (await rpc<Departed[] | null>('list_departed', { ws: st.workspaceId })) ?? []

/**
 * 自分からグループを抜ける（管理者は抜けられない）。
 * 本人　：handOver … これまでの記録を、実績としてグループに渡すか。渡さなければ、グループから引き上げる
 *         （管理者と指導者の端末からも、次の同期で消える）。どちらでも、この端末の記録は残る
 * 指導者：この端末から、グループの記録を消す（参加する前からこの端末にあった人の記録は残す）
 */
export async function leaveWorkspace(handOver = false) {
  const ws = st.workspaceId
  if (!ws) return
  // 抜ける前に同期する。まだ送っていない記録を届け、本人の端末には、指導者が入れた分まで受け取っておく
  await syncNow()
  if (st.workspaceId === ws && st.outbox.length) await syncNow()
  if (st.workspaceId !== ws) return // 同期しているあいだに、グループから外れていた
  const role = st.role
  const name = st.workspaceName ?? 'グループ'
  // 指導者は、抜けるとこの端末からグループの記録が消える。送れていない記録を失わないよう、残っているうちは抜けない
  if (role === 'coach' && st.outbox.length) throw new Error('まだ送れていない記録があります。少し待ってから、もう一度お試しください')
  await rpc<null>('leave_workspace', { ws, hand_over: handOver })
  if (role === 'client') { unlink(); return }
  wipeGroupRecords(ws)
  st = { outbox: [], notice: `「${name}」から抜けました。この端末にあったグループの記録を消しました（参加する前からこの端末にあった人の記録は、そのまま残っています）。` }
  save(); emit()
}

/** この端末から、グループの記録を消す。グループにつなぐ前からこの端末にあった人と、その人の記録は残す */
function wipeGroupRecords(ws: string) {
  for (const id of actions.keepOnlyMembers(new Set(loadBrought()[ws] ?? []))) {
    try { deleteImage(id).catch(() => {}) } catch { /* 無視 */ }
  }
}

// ───────── 外された本人：記録を実績として渡すかどうか ─────────

export interface Handover { workspace_id: string; workspace_name: string; member_id: string; member_name: string | null; departed_at: string; records: number }
/** 管理者に外されて、これまでの記録を実績として渡すかどうかを、まだ答えていないグループ */
export const myHandovers = async () => (await rpc<Handover[] | null>('my_handovers')) ?? []

/**
 * 外された本人の返事。give：これまでの記録を、実績としてグループに渡す（管理者と指導者が引き続き読める）。
 * 渡さなければ、グループからは消えたままになる。どちらでも、この端末の記録は変わらない。あとから変えることはできない
 */
export async function resolveHandover(h: Handover, give: boolean) {
  // 答えると、グループが預かっていた記録は、もう受け取れなくなる。この端末にまだ無い分を、先に受け取っておく
  await receiveHeld(h.workspace_id, h.member_id, true)
  await rpc<null>('resolve_handover', { ws: h.workspace_id, give })
}

interface Held { collection: string; id: string; data: unknown }

/**
 * 外された本人の「最後の受け取り」。外されたときにグループが預かった自分の記録を、この端末に入れる
 * （指導者が代わりに入れて、まだこの端末に届いていなかった分が、ここで届く）。
 * onlyMissing … false：まだつながっている端末が、外れたと分かったとき。同期と同じく、手元でまだ送っていない変更だけは上書きしない
 *               true ：あとから受け取るとき（同期を止めていた端末など）。この端末に無い記録だけを足す
 * この端末にその人がいなければ、何もしない（入れる先がないため）
 */
async function receiveHeld(ws: string, memberId: string, onlyMissing: boolean) {
  if (!actions.getState().members.some((m) => m.id === memberId)) return
  let after: [string, string] = ['', '']
  for (;;) {
    const rows = (await rpc<Held[] | null>('my_held_records', { ws, after_collection: after[0], after_id: after[1] })) ?? []
    if (!rows.length) return
    const mine = rows.filter((r) => RECORD_COLS.has(r.collection) && (r.data as { memberId?: string } | null)?.memberId === memberId)
    if (onlyMissing) {
      const s = actions.getState()
      for (const col of RECORD_COLS) {
        const have = new Set((s[col as keyof AppData] as { id: string }[]).map((x) => x.id))
        const add = mine.filter((r) => r.collection === col && !have.has(r.id)).map((r) => r.data)
        if (add.length) actions.upsertMany(col as RecordCol, add as never[])
      }
    } else {
      const pending = new Set(st.outbox)
      actions.applyRemote(mine.filter((r) => !pending.has(key(r.collection, r.id))).map((r) => ({ ...r, deleted: false })))
    }
    const last = rows[rows.length - 1]
    after = [last.collection, last.id]
    if (rows.length < 1000) return
  }
}

// ───────── 送受信 ─────────

/** グループを離れた人の控え（サーバー）。指導者：この端末のグループの記録を消すか。本人：記録を渡すかどうかの返事 */
interface Departure { role: 'coach' | 'client'; wipe_device: boolean; handover: HandoverState | null }

/** 自分の役割を確かめる。グループから外れていたら、この端末の同期を止める */
async function refreshMembership(): Promise<boolean> {
  const me = (await myWorkspaces()).find((w) => w.id === st.workspaceId)
  if (!me) {
    const ws = st.workspaceId!
    const name = st.workspaceName ?? 'グループ'
    // 離れた控えを読んで従う。聞けなかったとき（通信の失敗）は、何も変えずに、次の同期でやり直す
    const dep = await rpc<Departure | null>('my_departure', { ws })
    // 指導者：外した側が「端末の記録も消す」を選んだか、別の端末で自分から抜けていたら、この端末のグループの記録を消す
    const wipe = st.role !== 'client' && dep?.wipe_device === true
    // 本人：管理者に外されて、記録を渡すかどうかをまだ答えていない。グループが預かった自分の記録を、この端末に受け取っておく
    const asked = st.role === 'client' && dep?.handover === 'pending'
    if (asked && st.memberId) await receiveHeld(ws, st.memberId, false)
    if (wipe) wipeGroupRecords(ws)
    st = {
      outbox: [],
      notice: wipe
        ? `「${name}」から外れたため、同期を止めました。この端末にあったグループの記録を消しました（参加する前からこの端末にあった人の記録は、そのまま残っています）。`
        : asked
          ? `「${name}」から外れたため、同期を止めました。あなたの記録は、この端末に残っています。これまでの記録をグループに実績として渡すかどうかを、選んでください。`
          : `「${name}」から外れたため、同期を止めました。この端末の記録は、そのまま残っています。`,
    }
    save()
    return false
  }
  const memberId = me.member_id ?? undefined
  if (me.role !== st.role || memberId !== st.memberId || me.name !== st.workspaceName) {
    // 見える範囲が変わったときは、最初から受け取り直す
    if (st.role && (me.role !== st.role || memberId !== st.memberId)) { st.cursor = undefined; st.cursorAt = undefined }
    st.role = me.role
    st.memberId = memberId
    st.workspaceName = me.name
    save()
  }
  return true
}

/** 本人（client）は、いつも自分の記録を見る */
function keepOwnView() {
  if (st.role !== 'client' || !st.memberId) return
  const s = actions.getState()
  if (s.activeMemberId !== st.memberId && s.members.some((m) => m.id === st.memberId)) actions.setActiveMember(st.memberId)
}

let running: Promise<void> | null = null
export function syncNow(): Promise<void> {
  if (running) return running
  running = (async () => {
    try {
      if (!st.workspaceId || !(await session())) return
      if (!(await refreshMembership())) return
      await push()
      await pull()
      keepOwnView()
      st.lastSync = new Date().toISOString()
      save()
    } finally {
      running = null
      emit()
    }
  })()
  return running
}

interface Row { workspace_id: string; collection: string; id: string; data: unknown; deleted: boolean }

async function push() {
  if (!st.outbox.length) return
  const s = actions.getState()
  const keys = [...st.outbox]
  const rows: Row[] = []
  for (const k of keys) {
    const [col, id] = k.split('\u0000')
    const data = col === 'profile' ? s.profile : (s[col as keyof AppData] as { id: string }[]).find((x) => x.id === id)
    if (!sendable(col, data)) continue
    rows.push({ workspace_id: st.workspaceId!, collection: col, id, data: data ?? null, deleted: !data })
  }
  let rejected = 0
  for (let i = 0; i < rows.length; i += 500) rejected += await send(rows.slice(i, i + 500))
  if (rejected) {
    st.rejected = (st.rejected ?? 0) + rejected
    // 管理者・指導者の記録が断られるのは、本人が渡さずに持ち帰った記録を書き戻そうとしたとき。
    // その記録の削除を受け取りそこねていることがあるので、最初から受け取り直す（断られた記録は、この端末からも消える）
    if (st.role !== 'client') { st.cursor = undefined; st.cursorAt = undefined }
  }
  // 送っている間に増えた分は残す
  const sent = new Set(keys)
  st.outbox = st.outbox.filter((k) => !sent.has(k))
  save()
}

/**
 * まとめて送る。権限で断られたら半分ずつに分けて送り直し、断られた記録だけを外す
 * （1件のために、ほかの記録の送信が止まらないように）。断られた件数を返す
 */
async function send(rows: Row[]): Promise<number> {
  const { error } = await sb().from('records').upsert(rows, { onConflict: 'workspace_id,collection,id' })
  if (!error) return 0
  if (error.code !== '42501') throw error
  if (rows.length === 1) return 1
  const half = rows.length >> 1
  return (await send(rows.slice(0, half))) + (await send(rows.slice(half)))
}

interface Pulled { collection: string; id: string; data: unknown; deleted: boolean; updated_at: string }

async function pull() {
  for (;;) {
    // 続きは (更新時刻, コレクション, ID) で決める。更新時刻だけだと、同じ時刻の記録
    // （1回の送信や、まとめての削除）を、1000件の境目で取りこぼす
    const data = (await rpc<Pulled[] | null>('pull_records', {
      ws: st.workspaceId, after_ts: st.cursor ?? null, after_collection: st.cursorAt?.[0] ?? '', after_id: st.cursorAt?.[1] ?? '',
    })) ?? []
    if (!data.length) return
    // まだ送っていない手元の変更は、上書きしない（次の同期で送る）
    const pending = new Set(st.outbox)
    actions.applyRemote(data.filter((r) => !pending.has(key(r.collection, r.id))))
    const last = data[data.length - 1]
    st.cursor = last.updated_at
    st.cursorAt = [last.collection, last.id]
    save()
    if (data.length < 1000) return
  }
}

/** 起動時・画面に戻ったとき・一定間隔で同期する */
export function startAutoSync() {
  const run = () => { if (st.workspaceId) syncNow().catch(() => {}) }
  run()
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run() })
  window.addEventListener('online', run)
  setInterval(run, 60_000)
  // ほかの端末が書いたら、すぐ受け取る（グループが変わったら、つなぎ直す）
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  let channelFor: string | undefined
  const subscribe = () => {
    if (channelFor === st.workspaceId) return
    if (channel) { sb().removeChannel(channel).catch(() => {}); channel = null }
    channelFor = st.workspaceId
    if (!st.workspaceId) return
    channel = sb().channel('records-' + st.workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: `workspace_id=eq.${st.workspaceId}` }, () => schedule(300))
      .subscribe()
  }
  subscribe()
  onSyncState(subscribe)
}
