import { useEffect, useState } from 'react'
import { actions, useRawData } from '../store'
import { toast } from './ui'
import { availability, connect, disconnect, isNative, loadSync, openSettings, platformName, syncHealth } from '../lib/health'
import { useSyncState } from '../lib/sync'

// 設定画面：端末のヘルスケア連携（アプリ版のみ）
export function HealthCard() {
  const raw = useRawData()
  const link = useSyncState()
  const [sync, setSync] = useState(loadSync)
  const [avail, setAvail] = useState<{ ok: boolean; reason?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const name = platformName()

  useEffect(() => { availability().then(setAvail) }, [])

  if (!isNative()) {
    return (
      <div className="card">
        <div className="card-h"><h2>ヘルスケア連携</h2></div>
        <p className="sub" style={{ margin: 0, lineHeight: 1.7 }}>
          iPhoneのヘルスケア・AndroidのHealth Connectから、睡眠・歩数・体重・ウォーキングやバイクを自動で取り込めるのはアプリ版です。ブラウザ版では下のショートカットを使ってください。
        </p>
      </div>
    )
  }

  // 本人として参加中は、取り込み先を自分に固定する（ほかの人あての記録は同期されないため）
  const own = link.workspaceId && link.role === 'client' ? link.memberId : undefined
  const member = raw.members.find((m) => m.id === (own ?? sync.memberId ?? raw.activeMemberId)) ?? raw.members[0]
  const run = async (days: number) => {
    setBusy(true)
    try {
      const r = await syncHealth(actions.getState(), member.id, days)
      setSync(loadSync())
      toast(`取り込みました（睡眠${r.sleep}日・ワークアウト${r.workouts}件・身体測定${r.bodies}件）`)
    } catch (e) {
      toast('取り込めませんでした：' + String(e))
    } finally { setBusy(false) }
  }
  const start = async () => {
    setBusy(true)
    try {
      setSync(await connect(member.id))
      setBusy(false)
      await run(30)
    } catch (e) {
      toast('許可を求められませんでした：' + String(e))
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-h"><h2>{name}と連携</h2></div>
      {avail && !avail.ok && <div className="sub" style={{ color: 'var(--orange)', marginBottom: 8 }}>この端末では使えません（{avail.reason ?? '不明'}）{name === 'Health Connect' ? '。Health Connectをインストールしてください' : ''}</div>}
      <p className="sub" style={{ marginTop: 0, lineHeight: 1.7 }}>
        睡眠・歩数・歩行距離・体重・体脂肪率と、ウォーキング／ランニング／バイクのワークアウトを読み取ります。
        {link.workspaceId
          ? '取り込んだ記録は、ほかの記録と同じように同期されます（グループの管理者と指導者も読めます）。'
          : 'データは端末の中だけに保存し、外には送りません。'}
      </p>
      {!own && (
        <>
          <label className="label">この端末の持ち主（取り込む先）</label>
          <select value={member.id} onChange={(e) => { const s = { ...sync, memberId: e.target.value }; setSync(s); localStorage.setItem('physlog.health', JSON.stringify(s)) }}>
            {raw.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </>
      )}
      {!sync.connected ? (
        <button className="btn block primary" style={{ marginTop: 12 }} disabled={busy || avail?.ok === false} onClick={start}>{busy ? '連携中…' : `${name}と連携する`}</button>
      ) : (
        <>
          <div className="sub" style={{ marginTop: 10 }}>
            最終取り込み：{sync.lastSync ? new Date(sync.lastSync).toLocaleString('ja-JP') : 'まだ'}（アプリを開くたびに自動で取り込みます）
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
            <button className="btn sm primary" disabled={busy} onClick={() => run(14)}>{busy ? '取り込み中…' : '今すぐ取り込む'}</button>
            <button className="btn sm" disabled={busy} onClick={() => run(90)}>過去90日分</button>
            {name === 'Health Connect' && <button className="btn sm" onClick={() => openSettings()}>許可の設定</button>}
            <button className="btn sm" onClick={() => { disconnect(); setSync(loadSync()); toast('連携を止めました') }}>連携を止める</button>
          </div>
          {name !== 'Health Connect' && <div className="sub" style={{ marginTop: 8 }}>許可の変更：iPhoneの「設定」→「ヘルスケア」→「データアクセスとデバイス」→「PhysLog」</div>}
        </>
      )}
    </div>
  )
}
