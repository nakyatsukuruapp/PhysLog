// 設定：トレーニング場所（ジム）。器具構成を登録すると、記録画面でそのジムで作れる重量を候補に出す
import { useState } from 'react'
import { ALL_PLATES, GYM_PRESETS, MACHINE_UNIT_LABEL, barbellWeights, gymSummary, removeGym, saveGym, useGyms, type Gym, type MachineUnit } from '../lib/gyms'
import { ConfirmButton, toast } from './ui'

const nums = (s: string) => s.split(/[,、\s]+/).map((x) => Number(x.normalize('NFKC'))).filter((v) => Number.isFinite(v) && v > 0)

export function GymCard() {
  const gyms = useGyms()
  const [editing, setEditing] = useState<Gym | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  return (
    <div className="card">
      <div className="card-h"><h2>トレーニング場所（ジム）</h2></div>
      <p className="sub" style={{ marginTop: 0, lineHeight: 1.7 }}>
        ジムごとにバー・プレート・ダンベルの重さを登録すると、トレーニングの記録画面で、そのジムで作れる重量だけを候補に出します（この端末の設定です）。
      </p>
      {gyms.map((g) => (
        <div key={g.id} className="list-item tap" onClick={() => setEditing({ ...g })}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{g.name}{g.isDefault ? '（既定）' : ''}</div>
            <div className="sub">{gymSummary(g)}</div>
          </div>
          <span className="sub">›</span>
        </div>
      ))}
      {!adding ? (
        <button className="btn sm block" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>＋ ジムを登録</button>
      ) : (
        <div style={{ marginTop: 8 }}>
          <input placeholder="ジムの名前（例：エニタイム船橋）" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="sub" style={{ margin: '8px 0 4px', fontWeight: 700 }}>近いものを選んで、あとで直します</div>
          {GYM_PRESETS.map((p) => (
            <button key={p.name} className="list-item tap" style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none' }} disabled={!name.trim()}
              onClick={() => { const g = p.make(name.trim()); if (!gyms.length) g.isDefault = true; saveGym(g); setName(''); setAdding(false); toast('ジムを登録しました') }}>
              <div className="grow"><div style={{ fontWeight: 700 }}>{p.name}</div><div className="sub">{p.detail}</div></div>
            </button>
          ))}
          <button className="btn sm" onClick={() => setAdding(false)}>やめる</button>
        </div>
      )}
      {editing && <GymEditor gym={editing} onChange={setEditing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function GymEditor(props: { gym: Gym; onChange: (g: Gym) => void; onClose: () => void }) {
  const g = props.gym
  const set = (patch: Partial<Gym>) => props.onChange({ ...g, ...patch })
  const [bars, setBars] = useState(g.barWeights.join(', '))
  const sample = barbellWeights({ barWeights: nums(bars), plateWeights: g.plateWeights }, 120).slice(0, 12)
  return (
    <div className="card" style={{ background: 'var(--fill2)', marginTop: 10 }}>
      <label className="label">名前</label>
      <input value={g.name} onChange={(e) => set({ name: e.target.value })} />
      <label className="row" style={{ marginTop: 8, gap: 8 }}>
        <input type="checkbox" checked={g.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} style={{ width: 'auto' }} />
        <span>記録画面で最初から選ぶ（既定のジム）</span>
      </label>
      <label className="label">バーの重さ（kg。複数あれば「20, 15」のように）</label>
      <input inputMode="decimal" value={bars} onChange={(e) => setBars(e.target.value)} />
      <label className="label">プレート（片側1枚の重さ。置いてあるものを選ぶ）</label>
      <div className="chips">
        {ALL_PLATES.map((p) => {
          const on = g.plateWeights.includes(p)
          return <button key={p} className={'chip' + (on ? ' on' : '')} onClick={() => set({ plateWeights: on ? g.plateWeights.filter((x) => x !== p) : [...g.plateWeights, p].sort((a, b) => a - b) })}>{p}kg</button>
        })}
      </div>
      {sample.length > 0 && <div className="sub" style={{ marginTop: 6 }}>作れる重量の例：{sample.join(' / ')}kg …</div>}
      <label className="label">ダンベル（kg）</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
        {([['dumbbellMin', '最小'], ['dumbbellMax', '最大'], ['dumbbellStep', '刻み']] as const).map(([k, l]) => (
          <div key={k}>
            <div className="sub">{l}</div>
            <input inputMode="decimal" value={g[k]} onChange={(e) => set({ [k]: Number(e.target.value.normalize('NFKC')) || 0 })} aria-label={`ダンベルの${l}`} style={{ padding: '8px 10px' }} />
          </div>
        ))}
      </div>
      <label className="label">マシンの重量表記</label>
      <select value={g.machineUnit} onChange={(e) => set({ machineUnit: e.target.value as MachineUnit })}>
        {(Object.keys(MACHINE_UNIT_LABEL) as MachineUnit[]).map((u) => <option key={u} value={u}>{MACHINE_UNIT_LABEL[u]}</option>)}
      </select>
      {g.machineUnit === 'stack' && (
        <>
          <label className="label">1段あたりの重さ（kg。分からなければ空欄）</label>
          <input inputMode="decimal" value={g.machineStepWeight ?? ''} onChange={(e) => set({ machineStepWeight: Number(e.target.value) || undefined })} />
        </>
      )}
      <label className="label">メモ</label>
      <input value={g.memo} onChange={(e) => set({ memo: e.target.value })} />
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn sm primary" disabled={!g.name.trim()} onClick={() => { saveGym({ ...g, name: g.name.trim(), barWeights: nums(bars) }); props.onClose(); toast('保存しました') }}>保存</button>
        <button className="btn sm" onClick={props.onClose}>やめる</button>
        <ConfirmButton className="btn sm danger" label="このジムを削除" confirmLabel="もう一度押すと削除" onConfirm={() => { removeGym(g.id); props.onClose() }} />
      </div>
    </div>
  )
}
