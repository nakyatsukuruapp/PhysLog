// 端末間の同期（Supabase）。iPhone・Android・ブラウザのどれから入れても、同じワークスペースの全員に届く。
//
// しくみ
// - 記録を変えると、その記録のIDを「送信待ち」に積む（store の差分検知）
// - 同期のたびに：送信待ちを送る → サーバーで前回より後に変わった記録を受け取る
// - 同じ記録を2台で直したときは、後からサーバーに届いた方が残る
// - 端末の中の記録（localStorage）はそのまま使えるので、電波がなくても記録できる

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { actions, setChangeListener, SYNC_COLS, type Change } from '../store'
import type { AppData, Member } from '../types'

const URL = 'https://diobubwcrxeikonrhtmf.supabase.co'
// 公開してよい鍵（publishable）。データはログインした人が入っているワークスペースの分しか読めない（RLS）
const KEY = 'sb_publishable_tg2c5T9Dcc9Q0PseWLhEug_j5H3_zIp'

const LS = 'physlog.sync'
interface SyncState { workspaceId?: string; workspaceName?: string; inviteCode?: string; cursor?: string; lastSync?: string; outbox: string[]; linked?: boolean }
const load = (): SyncState => { try { return { outbox: [], ...JSON.parse(localStorage.getItem(LS) ?? '{}') } } catch { return { outbox: [] } } }
let st: SyncState = load()
const save = () => { try { localStorage.setItem(LS, JSON.stringify(st)) } catch { /* 無視 */ } }

let client: SupabaseClient | null = null
export const sb = () => (client ??= createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'physlog.auth' } }))

const listeners = new Set<() => void>()
export const onSyncState = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
const emit = () => listeners.forEach((f) => f())
export const syncState = () => st

// 記録が変わったら送信待ちに積み、少し待ってから送る
setChangeListener((ch: Change[]) => {
  if (!st.workspaceId) return
  const set = new Set(st.outbox)
  ch.forEach((c) => set.add(`${c.col}\u0000${c.id}`))
  st.outbox = [...set]
  save(); emit()
  schedule()
})
let timer: ReturnType<typeof setTimeout> | undefined
const schedule = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(() => { syncNow().catch(() => {}) }, ms) }

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

// ───────── ワークスペース ─────────

export async function createWorkspace(name: string) {
  const { data, error } = await sb().rpc('create_workspace', { ws_name: name })
  if (error) throw error
  await link(data.id, data.name, data.invite_code)
}
export async function joinWorkspace(code: string) {
  const { data, error } = await sb().rpc('join_workspace', { code })
  if (error) throw new Error(error.message.includes('not found') ? '招待コードが見つかりません' : error.message)
  await link(data.id, data.name, data.invite_code)
}

/** 端末とワークスペースを結びつける。初回は、端末の記録をすべて送る */
async function link(workspaceId: string, workspaceName: string, inviteCode: string) {
  st = { workspaceId, workspaceName, inviteCode, outbox: [], linked: false }
  save()
  // 1. サーバーにいるメンバーを読み、名前が同じ人は同じIDにそろえる
  const { data: rm, error } = await sb().from('records').select('id,data').eq('workspace_id', workspaceId).eq('collection', 'members').eq('deleted', false)
  if (error) throw error
  const remote = (rm ?? []).map((r) => r.data as Member)
  const map = new Map<string, string>()
  const local = actions.getState().members
  for (const m of local) {
    const same = remote.find((r) => r.name.trim() === m.name.trim())
    if (same) map.set(m.id, same.id)
    // 各端末の最初のメンバーは同じID（me）なので、ぶつからないよう付け替える
    else if (m.id === 'me') map.set(m.id, crypto.randomUUID())
  }
  actions.remapMembers(map, remote)
  // 2. 端末の記録をすべて送信待ちに積む
  const s = actions.getState()
  const all: string[] = []
  for (const col of SYNC_COLS) for (const x of s[col] as { id: string }[]) all.push(`${col}\u0000${x.id}`)
  if (s.profile.name || s.profile.sport) all.push('profile\u0000profile')
  st.outbox = all
  st.linked = true
  save()
  await syncNow()
}

export function unlink() {
  st = { outbox: [] }
  save(); emit()
}

// ───────── 送受信 ─────────

let running: Promise<void> | null = null
export function syncNow(): Promise<void> {
  if (running) return running
  running = (async () => {
    try {
      if (!st.workspaceId || !(await session())) return
      await push()
      await pull()
      st.lastSync = new Date().toISOString()
      save()
    } finally {
      running = null
      emit()
    }
  })()
  return running
}

async function push() {
  if (!st.outbox.length) return
  const s = actions.getState()
  const keys = [...st.outbox]
  const rows = keys.map((k) => {
    const [col, id] = k.split('\u0000')
    const data = col === 'profile' ? s.profile : (s[col as keyof AppData] as { id: string }[]).find((x) => x.id === id)
    return { workspace_id: st.workspaceId!, collection: col, id, data: data ?? null, deleted: !data }
  })
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb().from('records').upsert(rows.slice(i, i + 500), { onConflict: 'workspace_id,collection,id' })
    if (error) throw error
  }
  // 送っている間に増えた分は残す
  const sent = new Set(keys)
  st.outbox = st.outbox.filter((k) => !sent.has(k))
  save()
}

async function pull() {
  for (;;) {
    let q = sb().from('records').select('collection,id,data,deleted,updated_at').eq('workspace_id', st.workspaceId!).order('updated_at', { ascending: true }).limit(1000)
    if (st.cursor) q = q.gt('updated_at', st.cursor)
    const { data, error } = await q
    if (error) throw error
    if (!data?.length) return
    // まだ送っていない手元の変更は、上書きしない（次の同期で送る）
    const pending = new Set(st.outbox)
    actions.applyRemote(data.filter((r) => !pending.has(`${r.collection}\u0000${r.id}`)))
    st.cursor = data[data.length - 1].updated_at
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
  // ほかの端末が書いたら、すぐ受け取る
  let channel: ReturnType<SupabaseClient['channel']> | null = null
  const subscribe = () => {
    if (!st.workspaceId || channel) return
    channel = sb().channel('records-' + st.workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: `workspace_id=eq.${st.workspaceId}` }, () => schedule(300))
      .subscribe()
  }
  subscribe()
  onSyncState(subscribe)
}
