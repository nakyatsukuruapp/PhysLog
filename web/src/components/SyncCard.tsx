import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ConfirmButton, toast } from './ui'
import { useRawData } from '../store'
import {
  ROLE_LABEL, clearNotice, createInvite, createWorkspace, inviteInfo, joinWorkspace, leaveWorkspace, linkedMemberIds, listDeparted, listInvites, listPeople,
  myHandovers, myWorkspaces, removePerson, resolveHandover, resumeWorkspace, revokeInvite, sb, session, signIn, signOut, signUp, syncNow, unlink, useSyncState,
  type Departed, type Handover, type HandoverState, type Invite, type InviteInfo, type InviteRow, type MyWorkspace, type Person,
} from '../lib/sync'

type Run = (f: () => Promise<unknown>, ok?: string) => Promise<boolean>

const errorText = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string } | null)?.message ?? String(e))
/** 招待コードは5文字ずつに区切って見せる（入力のときは、区切りや小文字があっても通る） */
const showCode = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`
const day = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
/** グループを離れた本人の記録が、いまどうなっているか（管理者・指導者に見せる） */
const HANDOVER_LABEL: Record<HandoverState, string> = {
  pending: '本人の返事待ち。渡すと決めるまで、記録は見えません',
  given: '記録を、実績として受け取りました',
  declined: '記録は、渡されませんでした',
}

// 設定画面：端末間の同期と、グループ（管理者・指導者・本人）
export function SyncCard() {
  const st = useSyncState()
  const [ses, setSes] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    session().then(setSes).catch(() => setErr('サーバーにつながりません（このプレビューでは同期できません。アプリ版か公開版で使えます）'))
    const { data } = sb().auth.onAuthStateChange((_e, s) => setSes(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const run: Run = async (f, ok) => {
    setBusy(true); setErr('')
    try { await f(); if (ok) toast(ok); return true } catch (e) { setErr(errorText(e)); return false } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-h"><h2>同期（iPhone・Android・ブラウザ）</h2></div>
      {err && <div className="sub" style={{ color: 'var(--pink)', marginBottom: 8 }}>{err}</div>}
      {st.notice && (
        <div className="card" style={{ background: 'var(--fill2)', margin: '0 0 10px', padding: 12 }}>
          <div className="sub" style={{ lineHeight: 1.7 }}>{st.notice}</div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={clearNotice}>閉じる</button>
        </div>
      )}
      {ses && <Handovers busy={busy} run={run} watch={`${ses.user.id}|${st.workspaceId ?? ''}|${st.notice ?? ''}`} />}
      {!ses ? <Login busy={busy} run={run} />
        : !st.workspaceId ? <Start email={ses.user.email ?? ''} busy={busy} run={run} />
          : <Linked email={ses.user.email ?? ''} busy={busy} run={run} />}
    </div>
  )
}

function Login(props: { busy: boolean; run: Run }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const off = props.busy || !email || pw.length < 6
  return (
    <>
      <p className="sub" style={{ marginTop: 0, lineHeight: 1.7 }}>
        ログインすると、記録がどの端末からも同じになります。指導者や本人を招待コードで招いて、記録を共有することもできます。招かれた本人に見えるのは、自分の記録だけです。
      </p>
      <input type="email" autoComplete="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 8 }} />
      <input type="password" autoComplete="current-password" placeholder="パスワード（6文字以上）" value={pw} onChange={(e) => setPw(e.target.value)} />
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button className="btn sm primary" disabled={off} onClick={() => props.run(() => signIn(email, pw), 'ログインしました')}>ログイン</button>
        <button className="btn sm" disabled={off}
          onClick={() => props.run(async () => { const s = await signUp(email, pw); if (!s) throw new Error('確認メールを送りました。メールのリンクを押してから「ログイン」してください') }, '登録しました')}>はじめて使う（登録）</button>
      </div>
    </>
  )
}

/** 管理者に外されたあと：これまでの記録を、実績としてグループに渡すかどうかを、本人が選ぶ */
function Handovers(props: { busy: boolean; run: Run; watch: string }) {
  const { busy, run } = props
  const [list, setList] = useState<Handover[]>([])
  const reload = useCallback(() => myHandovers().then(setList).catch(() => {}), [])
  useEffect(() => { reload() }, [reload, props.watch])
  const answer = (h: Handover, give: boolean) => {
    run(async () => { await resolveHandover(h, give); await reload() }, give ? '実績として渡しました' : '渡さずに終わりました')
  }
  return (
    <>
      {list.map((h) => (
        <div key={h.workspace_id} className="card" style={{ background: 'var(--fill2)', margin: '0 0 10px', padding: 12 }}>
          <div style={{ lineHeight: 1.7 }}>
            「<b>{h.workspace_name}</b>」から外れました。これまでの記録（{h.member_name ?? 'あなた'} さんの {h.records}件）を、<b>実績としてグループに渡しますか。</b>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {busy ? <span className="sub">送信中…</span> : (
              <>
                <ConfirmButton className="btn sm primary" label="実績として渡す" confirmLabel="もう一度押すと渡します" onConfirm={() => answer(h, true)} />
                <ConfirmButton className="btn sm" label="渡さない" confirmLabel="もう一度押すと、渡さずに終わります" onConfirm={() => answer(h, false)} />
              </>
            )}
          </div>
          <div className="sub" style={{ lineHeight: 1.7, marginTop: 8 }}>
            どちらを選んでも、あなたの記録は、同期していた端末に残ります。答えるまで、グループの管理者と指導者からは見えません。「渡す」と、管理者と指導者が、これまでの記録を引き続き読めるようになります。「渡さない」と、グループからは消えたままになります。あとから変えることはできません。
          </div>
        </div>
      ))}
    </>
  )
}

/** ログイン済みで、この端末がまだどのグループにもつながっていないとき */
function Start(props: { email: string; busy: boolean; run: Run }) {
  const { busy, run } = props
  const raw = useRawData()
  const [mine, setMine] = useState<MyWorkspace[]>([])
  const [code, setCode] = useState('')
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const activeName = raw.members.find((m) => m.id === raw.activeMemberId)?.name ?? ''

  useEffect(() => { myWorkspaces().then(setMine).catch(() => {}) }, [])

  const begin = (
    <>
      <button className="btn block" disabled={busy} onClick={() => run(() => createWorkspace('PhysLog'), '同期を始めました')}>{busy ? '準備中…' : 'この端末の記録で同期を始める'}</button>
      <div className="sub" style={{ marginTop: 8, lineHeight: 1.7 }}>この端末の記録は、始めたときにまとめて送られます。あとから、指導者や本人を招待コードで招けます。</div>
    </>
  )

  return (
    <>
      <div className="sub" style={{ marginBottom: 10 }}>{props.email} でログイン中</div>

      {mine.length > 0 && (
        <>
          <label className="label">参加中のグループ</label>
          {mine.map((w) => (
            <div key={w.id} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{w.name}</b>
                <div className="sub">{ROLE_LABEL[w.role]}として参加中</div>
              </div>
              <button className="btn sm primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={busy} onClick={() => run(() => resumeWorkspace(w), '同期を始めました')}>この端末でも使う</button>
            </div>
          ))}
        </>
      )}

      <label className="label">招待コードで参加する</label>
      {!info ? (
        <div className="row" style={{ gap: 8 }}>
          <input placeholder="例 ABCDE-FGHJK" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: 2 }} />
          <button className="btn sm primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={busy || code.replace(/[^0-9A-Za-z]/g, '').length < 10}
            onClick={() => run(async () => setInfo(await inviteInfo(code)))}>確かめる</button>
        </div>
      ) : (
        <div className="card" style={{ background: 'var(--fill2)', margin: 0, padding: 12 }}>
          <div style={{ lineHeight: 1.7 }}>「<b>{info.workspace_name}</b>」に、<b>{ROLE_LABEL[info.role]}</b>として参加します。</div>
          <div className="sub" style={{ lineHeight: 1.7, margin: '6px 0 10px' }}>
            {info.role === 'client'
              ? `${info.member_name ?? 'あなた'} さんの記録として同期します。この端末でいま選んでいる人（${activeName}）の記録が送られ、グループの管理者と指導者が読み書きできるようになります。あなたに見えるのは、自分の記録だけです。グループを離れるときは、記録をこの端末に残したまま、実績として渡すかどうかを選べます。`
              : 'グループ全員の記録を読み書きできるようになります。この端末の記録（全員分）も、グループに送られます。グループから抜けると、この端末からグループの記録が消えます。管理者があなたを外すときは、消すかどうかを管理者が選びます（どちらの場合も、参加する前からこの端末にあった人の記録は残ります）。'}
          </div>
          {info.already_member ? (
            <div className="sub">このグループには、すでに参加しています。上の「参加中のグループ」から始めてください。</div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm primary" disabled={busy} onClick={() => run(() => joinWorkspace(code), '参加して同期しました')}>{busy ? '参加中…' : '参加する'}</button>
              <button className="btn sm" disabled={busy} onClick={() => setInfo(null)}>やめる</button>
            </div>
          )}
        </div>
      )}

      {mine.length > 0 ? (
        <details style={{ marginTop: 14 }}>
          <summary className="sub" style={{ cursor: 'pointer' }}>別のグループを新しく作る（自分が管理者になる）</summary>
          <div style={{ marginTop: 8 }}>{begin}</div>
        </details>
      ) : (
        <>
          <label className="label">新しく始める（自分が管理者になる）</label>
          {begin}
        </>
      )}
      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => run(signOut)}>ログアウト</button>
    </>
  )
}

/** この端末がグループにつながっているとき */
function Linked(props: { email: string; busy: boolean; run: Run }) {
  const { busy, run } = props
  const st = useSyncState()
  const raw = useRawData()
  const me = raw.members.find((m) => m.id === st.memberId)?.name
  return (
    <>
      <div className="sub" style={{ lineHeight: 1.8 }}>
        {props.email} でログイン中<br />
        グループ：{st.workspaceName ?? 'PhysLog'}（{st.role ? ROLE_LABEL[st.role] : '確認中'}）<br />
        最終同期：{st.lastSync ? new Date(st.lastSync).toLocaleString('ja-JP') : 'まだ'}{st.outbox.length ? `（送信待ち ${st.outbox.length}件）` : ''}
        {st.rejected ? <><br />権限がなく送れなかった記録：{st.rejected}件</> : null}
      </div>
      {st.role === 'client' && (
        <div className="sub" style={{ lineHeight: 1.7, marginTop: 8 }}>自分（{me ?? '本人'}）の記録だけを同期しています。グループの管理者と指導者も、この記録を読み書きできます。グループを離れるとき（抜ける・外される）は、記録をこの端末に残したまま、実績として渡すかどうかを選べます。</div>
      )}
      {st.role === 'coach' && (
        <div className="sub" style={{ lineHeight: 1.7, marginTop: 8 }}>グループ全員の記録を読み書きできます。本人を招くこともできます。指導者を招く・人を外すのは、管理者だけができます。グループから抜けると、この端末からグループの記録が消えます。管理者があなたを外すときは、消すかどうかを管理者が選びます（どちらの場合も、参加する前からこの端末にあった人の記録は残ります）。</div>
      )}
      {(st.role === 'owner' || st.role === 'coach') && <StaffTools owner={st.role === 'owner'} busy={busy} run={run} />}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn sm primary" disabled={busy} onClick={() => run(syncNow, '同期しました')}>{busy ? '同期中…' : '今すぐ同期'}</button>
        <button className="btn sm" onClick={unlink}>この端末の同期を止める</button>
        <button className="btn sm" onClick={() => run(signOut)}>ログアウト</button>
      </div>
      {st.role === 'coach' && (
        <ConfirmButton className="btn sm danger" style={{ marginTop: 10 }} label="このグループから抜ける"
          confirmLabel="もう一度押すと抜けます（この端末から、グループの記録が消えます）" onConfirm={() => { run(() => leaveWorkspace(), 'グループから抜けました') }} />
      )}
      {st.role === 'client' && (
        <>
          <label className="label">グループから抜ける（記録を実績として渡すか選ぶ）</label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <ConfirmButton className="btn sm" label="実績として渡して抜ける" confirmLabel="もう一度押すと、渡して抜けます"
              onConfirm={() => { run(() => leaveWorkspace(true), 'グループから抜けました（記録は、実績として渡しました）') }} />
            <ConfirmButton className="btn sm" label="渡さずに抜ける" confirmLabel="もう一度押すと、渡さずに抜けます"
              onConfirm={() => { run(() => leaveWorkspace(false), 'グループから抜けました（記録は渡していません）') }} />
          </div>
          <div className="sub" style={{ lineHeight: 1.7, marginTop: 8 }}>
            どちらを選んでも、この端末には自分の記録が残ります。「渡さずに抜ける」では、グループに預けた自分の記録が消え、管理者と指導者の画面からも、次の同期で消えます。「実績として渡して抜ける」では、これまでの記録がグループに残り、管理者と指導者が引き続き読めます。相手がすでに書き出したバックアップまでは消せません。
          </div>
        </>
      )}
    </>
  )
}

/** 管理者・指導者：本人を招く。管理者だけ：指導者を招く、人を外す */
function StaffTools(props: { owner: boolean; busy: boolean; run: Run }) {
  const { owner, busy, run } = props
  const raw = useRawData()
  const [people, setPeople] = useState<Person[]>([])
  const [linked, setLinked] = useState<string[]>([])
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [issued, setIssued] = useState<Invite | null>(null)
  const [target, setTarget] = useState('')
  const [departed, setDeparted] = useState<Departed[]>([])
  const [removing, setRemoving] = useState('') // 外そうとしている人（user_id）

  const reload = useCallback(async () => {
    // 参加している人の一覧（メールアドレスつき）は管理者だけ。指導者は、結びつき済みの人だけを知る
    const [p, ids, i, d] = await Promise.all([
      owner ? listPeople() : Promise.resolve<Person[]>([]), owner ? Promise.resolve<string[]>([]) : linkedMemberIds(), listInvites(), listDeparted(),
    ])
    setPeople(p); setLinked(ids); setInvites(i); setDeparted(d)
  }, [owner])
  useEffect(() => { reload().catch(() => {}) }, [reload])

  const nameOf = (id: string | null) => raw.members.find((m) => m.id === id)?.name ?? '（消した人）'
  // まだアカウントが結びついていない人だけ、本人として招ける
  const taken = new Set<string | null>(owner ? people.map((p) => p.member_id) : linked)
  const free = raw.members.filter((m) => !taken.has(m.id))
  // 誰を招くかは、毎回選んでもらう（その人の記録を見せる相手を決める操作なので、最初から誰かを選んだ状態にしない）
  const pick = free.some((m) => m.id === target) ? target : ''
  const pending = invites.filter((i) => !i.used_at && new Date(i.expires_at).getTime() > Date.now())
  const issue = (role: 'coach' | 'client') => run(async () => { setIssued(await createInvite(role, pick)); await reload() })
  // 指導者を外す。相手の端末に残っているグループの記録を消すかどうかは、外す側が選ぶ
  const removeCoach = (userId: string, wipeDevice: boolean) => run(
    async () => { await removePerson(userId, wipeDevice); setRemoving(''); await reload() },
    wipeDevice ? '外しました（相手の端末の記録も消します）' : '外しました（相手の端末の記録は残ります）',
  )
  // 本人を外す。その人の記録はグループから見えなくなり、渡すかどうかは本人が選ぶ。この端末からも消えるよう、続けて同期する
  const removeClient = (userId: string) => run(
    async () => { await removePerson(userId); setRemoving(''); await reload(); await syncNow().catch(() => {}) },
    '外しました（記録は、本人が渡すと決めるまで見えません）',
  )

  return (
    <>
      <label className="label">本人を招く（その人自身の記録だけを読み書きできる）</label>
      {free.length ? (
        <div className="row" style={{ gap: 8 }}>
          <select value={pick} onChange={(e) => setTarget(e.target.value)} aria-label="招く人">
            <option value="">誰を招くか選ぶ</option>
            {free.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button className="btn sm primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }} disabled={busy || !pick} onClick={() => issue('client')}>招待コードを作る</button>
        </div>
      ) : (
        <div className="sub">招ける人がいません。下の「記録する人」に名前を足すと、ここに出ます。</div>
      )}

      {owner && (
        <>
          <label className="label">指導者を招く（グループ全員の記録を読み書きでき、本人を招ける）</label>
          <button className="btn sm" disabled={busy} onClick={() => issue('coach')}>指導者の招待コードを作る</button>
        </>
      )}

      {issued && (
        <div className="card" style={{ background: 'var(--fill2)', margin: '12px 0 0', padding: 12 }}>
          <div className="sub">{issued.role === 'client' ? `${nameOf(issued.member_id)} さん（本人）` : '指導者'}に伝える招待コード</div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 3 }}>{showCode(issued.code)}</div>
          <div className="sub" style={{ lineHeight: 1.7 }}>1回だけ使えます。期限は {day(issued.expires_at)} まで。このコードは、いまだけ表示されます。</div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn sm primary" onClick={() => navigator.clipboard.writeText(showCode(issued.code)).then(() => toast('コピーしました'), () => toast('コピーできませんでした'))}>コピー</button>
            <button className="btn sm" onClick={() => setIssued(null)}>閉じる</button>
          </div>
        </div>
      )}

      {owner && (
        <>
          <label className="label">参加している人</label>
          {people.map((p) => (
            <div key={p.user_id}>
              <div className="list-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{p.role === 'client' ? nameOf(p.member_id) : ROLE_LABEL[p.role]}</b>
                  {p.role === 'client' && <span className="sub">　本人</span>}
                  <div className="sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.email}</div>
                </div>
                {p.role !== 'owner' && (
                  <button className={`chip ${removing === p.user_id ? 'on' : ''}`} disabled={busy} onClick={() => setRemoving(removing === p.user_id ? '' : p.user_id)}>外す</button>
                )}
              </div>
              {removing === p.user_id && p.role === 'client' && (
                <div className="card" style={{ background: 'var(--fill2)', margin: '8px 0 10px', padding: 12 }}>
                  <div style={{ lineHeight: 1.7 }}>{nameOf(p.member_id)} さんを外すと、この人の記録は、グループから見えなくなります。</div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    <button className="btn sm danger" disabled={busy} onClick={() => removeClient(p.user_id)}>外す</button>
                    <button className="btn sm" disabled={busy} onClick={() => setRemoving('')}>やめる</button>
                  </div>
                  <div className="sub" style={{ lineHeight: 1.7, marginTop: 8 }}>
                    記録は、本人の端末に残ります。本人が「実績として渡す」を選んだときだけ、グループに戻ります。「渡さない」を選ぶと、戻りません。管理者と指導者の端末からは、次の同期で消えます。すでに書き出したバックアップには残ります。
                  </div>
                </div>
              )}
              {removing === p.user_id && p.role === 'coach' && (
                <div className="card" style={{ background: 'var(--fill2)', margin: '8px 0 10px', padding: 12 }}>
                  <div style={{ lineHeight: 1.7 }}>この指導者の端末に残っている、グループの記録をどうしますか。</div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    <button className="btn sm" disabled={busy} onClick={() => removeCoach(p.user_id, false)}>残して外す</button>
                    <button className="btn sm danger" disabled={busy} onClick={() => removeCoach(p.user_id, true)}>消して外す</button>
                    <button className="btn sm" disabled={busy} onClick={() => setRemoving('')}>やめる</button>
                  </div>
                  <div className="sub" style={{ lineHeight: 1.7, marginTop: 8 }}>
                    どちらを選んでも、記録はグループに残ります。「消して外す」では、相手が次にアプリで同期しようとしたときに、その端末からグループの記録が消えます（相手が参加する前から持っていた人の記録は残ります）。相手の端末に電波がないあいだは消えず、すでに書き出されたバックアップまでは消せません。
                  </div>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {pending.length > 0 && (
        <>
          <label className="label">{owner ? '招待中（まだ使われていないコード）' : '自分が出した招待（まだ使われていないコード）'}</label>
          {pending.map((i) => (
            <div key={i.id} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                {i.role === 'client' ? `${nameOf(i.member_id)}（本人）` : '指導者'}
                <div className="sub">期限 {day(i.expires_at)}</div>
              </div>
              <button className="chip" disabled={busy} onClick={() => run(async () => { await revokeInvite(i.id); await reload() }, '取り消しました')}>取り消す</button>
            </div>
          ))}
        </>
      )}

      {departed.length > 0 && (
        <>
          <label className="label">グループを離れた本人</label>
          {departed.map((d) => (
            <div key={`${d.member_id}|${d.departed_at}`} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{d.member_name ?? nameOf(d.member_id)}</b>
                <div className="sub" style={{ lineHeight: 1.6 }}>{day(d.resolved_at ?? d.departed_at)}　{HANDOVER_LABEL[d.handover]}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  )
}
