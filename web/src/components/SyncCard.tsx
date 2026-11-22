import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { toast } from './ui'
import { createWorkspace, joinWorkspace, onSyncState, sb, session, signIn, signOut, signUp, syncNow, syncState, unlink } from '../lib/sync'

// 設定画面：端末間の同期（iPhone・Android・ブラウザで同じ記録を見る）
export function SyncCard() {
  const [ses, setSes] = useState<Session | null>(null)
  const [st, setSt] = useState(syncState)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    session().then(setSes).catch(() => setErr('サーバーにつながりません（このプレビューでは同期できません。アプリ版か公開版で使えます）'))
    const { data } = sb().auth.onAuthStateChange((_e, s) => setSes(s))
    const off = onSyncState(() => setSt({ ...syncState() }))
    return () => { data.subscription.unsubscribe(); off() }
  }, [])

  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setErr('')
    try { await f(); if (ok) toast(ok) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false); setSt({ ...syncState() }) }
  }

  return (
    <div className="card">
      <div className="card-h"><h2>同期（iPhone・Android・ブラウザ）</h2></div>
      {err && <div className="sub" style={{ color: 'var(--pink)', marginBottom: 8 }}>{err}</div>}

      {!ses ? (
        <>
          <p className="sub" style={{ marginTop: 0, lineHeight: 1.7 }}>
            ログインすると、記録がどの端末からも同じになります。一緒に記録する人（Katsuraなど）とも、招待コードで共有できます。
          </p>
          <input type="email" autoComplete="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 8 }} />
          <input type="password" autoComplete="current-password" placeholder="パスワード（6文字以上）" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn sm primary" disabled={busy || !email || pw.length < 6} onClick={() => run(() => signIn(email, pw), 'ログインしました')}>ログイン</button>
            <button className="btn sm" disabled={busy || !email || pw.length < 6}
              onClick={() => run(async () => { const s = await signUp(email, pw); if (!s) throw new Error('確認メールを送りました。メールのリンクを押してから「ログイン」してください') }, '登録しました')}>はじめて使う（登録）</button>
          </div>
        </>
      ) : !st.workspaceId ? (
        <>
          <div className="sub" style={{ marginBottom: 10 }}>{ses.user.email} でログイン中</div>
          <label className="label">招待コードで参加する（共有してもらう側）</label>
          <div className="row" style={{ gap: 8 }}>
            <input placeholder="例 3F9A1C2B" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: 2 }} />
            <button className="btn sm primary" disabled={busy || code.trim().length < 6} onClick={() => run(() => joinWorkspace(code), '参加して同期しました')}>参加</button>
          </div>
          <label className="label">新しく始める（共有する側）</label>
          <button className="btn block" disabled={busy} onClick={() => run(() => createWorkspace('PhysLog'), '同期を始めました')}>{busy ? '準備中…' : 'この端末の記録で同期を始める'}</button>
          <div className="sub" style={{ marginTop: 8 }}>この端末の記録は、参加・開始したときにまとめて送られます。名前が同じ人（Ryota・Katsura）は同じ人としてまとめます。</div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => run(signOut)}>ログアウト</button>
        </>
      ) : (
        <>
          <div className="sub" style={{ lineHeight: 1.8 }}>
            {ses.user.email} でログイン中<br />
            最終同期：{st.lastSync ? new Date(st.lastSync).toLocaleString('ja-JP') : 'まだ'}{st.outbox.length ? `（送信待ち ${st.outbox.length}件）` : ''}
          </div>
          <div className="card" style={{ background: 'var(--fill2)', margin: '10px 0', padding: 12 }}>
            <div className="sub">一緒に記録する人に教える招待コード</div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 4 }}>{st.inviteCode}</div>
            <div className="sub">相手もPhysLogで登録して、このコードで「参加」します。</div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm primary" disabled={busy} onClick={() => run(syncNow, '同期しました')}>{busy ? '同期中…' : '今すぐ同期'}</button>
            <button className="btn sm" onClick={() => { unlink(); setSt({ ...syncState() }) }}>この端末の同期を止める</button>
            <button className="btn sm" onClick={() => run(signOut)}>ログアウト</button>
          </div>
        </>
      )}
    </div>
  )
}
