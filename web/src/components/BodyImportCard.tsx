// 設定：体組成の取り込み。体組成計の CSV と、結果用紙・アプリ画面の写真（iPhone 版。端末の中で文字を読み取る）
import { useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { FIELD_LABEL, buildRows, decodeCSV, extractFromLines, guessMapping, mergeRows, splitRows, type ImportField, type ImportRow } from '../lib/bodyImport'
import { actions, uid, useRawData } from '../store'
import { todayKey } from '../lib/format'
import { toast } from './ui'

const OCR = registerPlugin<{ recognizeText(o: { image: string }): Promise<{ lines: string[] }> }>('LegacyImport')
const canOCR = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

interface CsvState { headers: string[]; rows: string[][]; mapping: ImportField[]; encoding: string }

export function BodyImportCard() {
  const data = useRawData()
  const csvInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const [csv, setCsv] = useState<CsvState | null>(null)
  const [scan, setScan] = useState<{ row: ImportRow; lines: string[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const onCsv = async (f: File) => {
    const dec = decodeCSV(new Uint8Array(await f.arrayBuffer()))
    const rows = dec ? splitRows(dec.text) : []
    if (!dec || rows.length < 2) { toast('取り込める行が見つかりませんでした'); return }
    setCsv({ headers: rows[0], rows: rows.slice(1), mapping: guessMapping(rows[0]), encoding: dec.encoding })
  }
  const onPhoto = async (f: File) => {
    setBusy(true)
    try {
      const image = await new Promise<string>((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = ng; r.readAsDataURL(f) })
      const { lines } = await OCR.recognizeText({ image })
      if (!lines.length) { toast('文字を読み取れませんでした'); return }
      setScan({ row: extractFromLines(lines, todayKey()), lines })
    } catch { toast('文字を読み取れませんでした') } finally { setBusy(false) }
  }
  const save = (rows: ImportRow[], memo: string) => {
    const r = mergeRows(data.bodies, rows, data.activeMemberId, uid, memo)
    actions.upsertMany('bodies', r.items)
    toast(r.added || r.merged ? `取り込みました（追加 ${r.added}件・補完 ${r.merged}件）` : '新しく入る値はありませんでした')
  }

  const preview = csv ? buildRows(csv.rows, csv.mapping) : []
  const valid = preview.filter((r) => r.date)

  return (
    <div className="card">
      <div className="card-h"><h2>体組成の取り込み</h2></div>
      <p className="sub" style={{ marginTop: 0, lineHeight: 1.7 }}>
        体組成計の CSV{canOCR() ? 'や、結果用紙・アプリ画面の写真' : ''}から、体重・体脂肪率・筋肉量を取り込みます。入力済みの記録は上書きせず、空いている項目だけを埋めます。
        {canOCR() ? '写真の文字は端末の中で読み取り、外へは送りません。' : ''}
      </p>
      <div className="grid2">
        <button className="btn" onClick={() => csvInput.current?.click()}>CSV を選ぶ</button>
        {canOCR() && <button className="btn" disabled={busy} onClick={() => photoInput.current?.click()}>{busy ? '読み取り中…' : '写真から読み取る'}</button>}
      </div>
      <input ref={csvInput} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsv(f); e.target.value = '' }} />
      <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = '' }} />

      {csv && (
        <div className="card" style={{ background: 'var(--fill2)', marginTop: 10 }}>
          <div className="sub" style={{ marginBottom: 6 }}>列の対応（見出しから推定しました。違っていれば直してください）・文字コード {csv.encoding}</div>
          {csv.headers.map((h, i) => (
            <div key={i} className="row" style={{ gap: 8, marginBottom: 4 }}>
              <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h || `（${i + 1}列目）`}</span>
              <select style={{ width: 'auto' }} value={csv.mapping[i]} onChange={(e) => setCsv({ ...csv, mapping: csv.mapping.map((m, j) => (j === i ? e.target.value as ImportField : m)) })}>
                {(Object.keys(FIELD_LABEL) as ImportField[]).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
              </select>
            </div>
          ))}
          <div className="sub" style={{ margin: '8px 0' }}>
            取り込める行：{valid.length}件{preview.length > valid.length ? `（日付が読めない ${preview.length - valid.length}件は取り込みません）` : ''}
            {valid[0] ? `　例：${valid[0].date} ${summary(valid[0])}` : ''}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" disabled={!valid.length} onClick={() => { save(valid, 'CSV から取り込み'); setCsv(null) }}>{valid.length}件を取り込む</button>
            <button className="btn sm" onClick={() => setCsv(null)}>やめる</button>
          </div>
        </div>
      )}

      {scan && (
        <div className="card" style={{ background: 'var(--fill2)', marginTop: 10 }}>
          <div className="sub" style={{ marginBottom: 6 }}>読み取った値（違っていれば直してください）</div>
          <label className="label">測定日</label>
          <input type="date" value={scan.row.date ?? ''} onChange={(e) => setScan({ ...scan, row: { ...scan.row, date: e.target.value } })} />
          {(['weight', 'bodyFat', 'muscle'] as const).map((k) => (
            <div key={k}>
              <label className="label">{FIELD_LABEL[k]}（{k === 'bodyFat' ? '%' : 'kg'}）</label>
              <input inputMode="decimal" value={scan.row[k] ?? ''} placeholder="読み取れませんでした"
                onChange={(e) => { const v = Number(e.target.value.normalize('NFKC')); setScan({ ...scan, row: { ...scan.row, [k]: e.target.value === '' || !Number.isFinite(v) ? undefined : v } }) }} />
            </div>
          ))}
          <details style={{ marginTop: 8 }}>
            <summary className="sub" style={{ cursor: 'pointer' }}>読み取った文字（{scan.lines.length}行）</summary>
            <div className="sub" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{scan.lines.join('\n')}</div>
          </details>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn sm primary" disabled={!scan.row.date || (scan.row.weight == null && scan.row.bodyFat == null && scan.row.muscle == null)}
              onClick={() => { save([scan.row], '写真から取り込み'); setScan(null) }}>保存</button>
            <button className="btn sm" onClick={() => setScan(null)}>やめる</button>
          </div>
        </div>
      )}
    </div>
  )
}

function summary(r: ImportRow) {
  return [r.weight != null && `${r.weight}kg`, r.bodyFat != null && `${r.bodyFat}%`, r.muscle != null && `筋${r.muscle}kg`].filter(Boolean).join(' / ')
}
