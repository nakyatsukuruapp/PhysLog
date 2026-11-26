// 体組成の取り込み（CSV と、結果用紙・画面の写真の文字の読み取り）。旧版（SwiftUI 版）の ImportModels / CSVImporter / OCRImporter と同じ決まり。
// どちらの経路でも ImportRow にそろえ、確認してから保存する。保存では、入力済みの記録を上書きせず、空いている項目だけを埋める。
import type { BodyMeasurement } from '../types'

export type ImportField = 'date' | 'weight' | 'bodyFat' | 'muscle' | 'skip'
export const FIELD_LABEL: Record<ImportField, string> = { date: '測定日', weight: '体重', bodyFat: '体脂肪率', muscle: '筋肉量', skip: '取り込まない' }
export interface ImportRow { date?: string; weight?: number; bodyFat?: number; muscle?: number; raw: string }

/** 見出しの自動推定の手がかり（メーカーごとの表記ゆれを広めに拾う） */
const KEYWORDS: Record<Exclude<ImportField, 'skip'>, string[]> = {
  date: ['測定日', '日付', '日時', '計測日', 'date', 'time', '測定日時'],
  weight: ['体重', 'weight', 'wt', '体重(kg)', '体重kg'],
  bodyFat: ['体脂肪率', '体脂肪', 'bodyfat', 'body fat', 'fat', 'pbf', '体脂肪率(%)'],
  // InBody は「骨格筋量(SMM)」、タニタは「筋肉量」
  muscle: ['骨格筋量', '筋肉量', 'smm', 'skeletal muscle', 'muscle', '除脂肪', 'ffm', 'lbm'],
}
const FIELDS = ['date', 'weight', 'bodyFat', 'muscle'] as const

/** 全角→半角、大文字小文字・空白・記号ゆれをそろえる */
export function normalize(s: string): string {
  return toHalf(s).toLowerCase().replace(/[\s　_-]/g, '').trim()
}
const toHalf = (s: string) => s.normalize('NFKC')

/** 見出し行から、各列の項目を推定する。「体脂肪量」は「体脂肪率」と取り違えないよう先に弾く */
export function guessMapping(headers: string[]): ImportField[] {
  return headers.map((h) => {
    const n = normalize(h)
    if (!n) return 'skip'
    if (n.includes('脂肪量') || n.includes('fatmass')) return 'skip'
    for (const f of FIELDS) if (KEYWORDS[f].some((k) => normalize(k) === n)) return f
    for (const f of FIELDS) if (KEYWORDS[f].some((k) => k && n.includes(normalize(k)))) return f
    return 'skip'
  })
}

/** 「68.5」「68.5kg」「６８．５」を数にする */
export function parseNumber(raw: string): number | undefined {
  const f = toHalf(raw).replace(/[^0-9.\-]/g, '')
  if (!f) return undefined
  const v = Number(f)
  return Number.isFinite(v) ? v : undefined
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const dt = new Date(y, m - 1, d)
  if (dt.getMonth() !== m - 1) return undefined
  return `${y}-${pad(m)}-${pad(d)}`
}

/** よくある日付の書き方をひと通り読む（YYYY/MM/DD・YYYY-MM-DD・YYYY.MM.DD・YYYYMMDD(hhmmss)・YYYY年MM月DD日・YY/MM/DD。時刻は捨てる） */
export function parseDate(raw: string): string | undefined {
  const s = toHalf(raw).trim()
  let m = s.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{6})?$/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{2})\/(\d{1,2})\/(\d{1,2})$/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  return undefined
}

/** 行の中から日付らしいところを探して読む（写真では「測定日 2026/07/20」のように前後に文字が付く） */
export function firstDate(line: string): string | undefined {
  const s = toHalf(line)
  for (const re of [/\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, /\d{4}年\d{1,2}月\d{1,2}日/g, /\d{8}/g]) {
    for (const m of s.matchAll(re)) { const d = parseDate(m[0]); if (d) return d }
  }
  return undefined
}

// ───────── CSV ─────────

/** バイト列を文字にする。日本の測定機器の CSV は Shift_JIS が多いので、UTF-8 → Shift_JIS → EUC-JP → UTF-16 の順に試す */
export function decodeCSV(bytes: Uint8Array): { text: string; encoding: string } | null {
  for (const enc of ['utf-8', 'shift_jis', 'euc-jp', 'utf-16le']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(bytes)
      if (text) return { text: text.replace(/^﻿/, ''), encoding: enc === 'utf-8' ? 'UTF-8' : enc === 'shift_jis' ? 'Shift_JIS' : enc === 'euc-jp' ? 'EUC-JP' : 'UTF-16' }
    } catch { /* 次の候補へ */ }
  }
  return null
}

/** 引用符・引用符内の改行・"" の引用符・タブ区切りに対応した読み取り。空の行は落とす */
export function splitRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', q = false
  const endField = () => { row.push(field.trim()); field = '' }
  const endRow = () => { endField(); if (row.some((c) => c !== '')) rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else q = false } else field += c
      continue
    }
    if (c === '"') q = true
    else if (c === ',' || c === '\t') endField()
    else if (c === '\r') { if (text[i + 1] === '\n') i++; endRow() }
    else if (c === '\n') endRow()
    else field += c
  }
  if (field !== '' || row.length) endRow()
  return rows
}

/** 列の対応に従って行にする（値のない行は落とす） */
export function buildRows(rows: string[][], mapping: ImportField[]): ImportRow[] {
  const out: ImportRow[] = []
  for (const cols of rows) {
    const r: ImportRow = { raw: cols.join(', ') }
    mapping.forEach((f, i) => {
      const v = cols[i]
      if (!v) return
      if (f === 'date') r.date = parseDate(v)
      else if (f === 'weight') r.weight = parseNumber(v)
      else if (f === 'bodyFat') r.bodyFat = parseNumber(v)
      else if (f === 'muscle') r.muscle = parseNumber(v)
    })
    if (r.weight != null || r.bodyFat != null || r.muscle != null) out.push(r)
  }
  return out
}

// ───────── 写真の文字（読み取った行から数値を拾う） ─────────

/** 項目名の行と同じ行、なければ次の行の数値を拾う。機種ごとにレイアウトが違うので、候補として出して確認してもらう */
export function extractFromLines(lines: string[], today: string): ImportRow {
  const r: ImportRow = { raw: lines.join(' / ') }
  lines.forEach((line, i) => {
    const n = normalize(line)
    for (const f of ['weight', 'bodyFat', 'muscle'] as const) {
      if (r[f] != null) continue
      if (!KEYWORDS[f].some((k) => n.includes(normalize(k)))) continue
      if (n.includes('脂肪量')) continue // 体脂肪「量」は別項目
      const v = firstNumber(line, KEYWORDS[f]) ?? (i + 1 < lines.length ? firstNumber(lines[i + 1], []) : undefined)
      if (v != null) r[f] = v
    }
    if (!r.date) r.date = firstDate(line)
  })
  if (!r.date) r.date = today // 読めなければ今日（確認画面で直せる）
  return r
}

/** 行から最初の妥当な数値（項目名に含まれる数字は除き、体組成として現実的な 0〜400 だけ） */
function firstNumber(line: string, exclude: string[]): number | undefined {
  let t = toHalf(line)
  for (const k of exclude) t = t.split(toHalf(k)).join(' ')
  for (const m of t.matchAll(/[0-9]+\.?[0-9]*/g)) {
    const v = Number(m[0])
    if (v > 0 && v < 400) return v
  }
  return undefined
}

// ───────── 保存 ─────────

/** 取り込む行を、身体測定に合わせる。同じ人の同じ日の記録があれば、空いている項目だけを埋める。なければ新しく足す */
export function mergeRows(existing: BodyMeasurement[], rows: ImportRow[], memberId: string, newId: () => string, memo: string): { items: BodyMeasurement[]; added: number; merged: number } {
  const mine = existing.filter((b) => (b.memberId ?? memberId) === memberId)
  const byDate = new Map<string, BodyMeasurement>()
  let added = 0, merged = 0
  for (const r of rows) {
    if (!r.date || (r.weight == null && r.bodyFat == null && r.muscle == null)) continue
    const cur = byDate.get(r.date) ?? mine.find((b) => b.date === r.date)
    if (cur) {
      const next = { ...cur, weight: cur.weight ?? r.weight, bodyFat: cur.bodyFat ?? r.bodyFat, muscle: cur.muscle ?? r.muscle }
      if (next.weight !== cur.weight || next.bodyFat !== cur.bodyFat || next.muscle !== cur.muscle) {
        if (!byDate.has(r.date) || mine.some((b) => b.id === cur.id)) merged++
        byDate.set(r.date, next)
      }
    } else {
      byDate.set(r.date, { id: newId(), memberId, date: r.date, weight: r.weight, bodyFat: r.bodyFat, muscle: r.muscle, memo })
      added++
    }
  }
  return { items: [...byDate.values()], added, merged }
}
