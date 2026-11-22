// 1行メモ形式のトレーニング記録を読み取る。
//
//   トレーニング記録 2026/11/12
//   Ryota,Katsura
//   BSQ 20kg 5rep 1set,60kg 5rep 3set
//   2db
//   ランジ→2up 10kg 5 3
//
// 方針：略称・表記ゆれ・打ち間違いは推測して埋めるが、推測した箇所は
// confidence を下げて確認画面で目立たせる（勝手に確定させない）。

import type { ActivityKind, SetEntry } from '../types'
import { EXERCISES, EXERCISE_ALIASES } from './presets'
import { hoursAcrossMidnight, toKey } from './format'

export interface ParsedExercise {
  key: string
  raw: string
  name: string
  /** exact: 辞書・履歴と一致 / alias: 略称から変換 / fuzzy: 打ち間違いを推測 / unknown: 不明 / missing: 種目名なし */
  match: 'exact' | 'alias' | 'fuzzy' | 'unknown' | 'missing'
  sets: SetEntry[]
  note?: string
}

export interface ParsedSleep {
  hours?: number
  bedtime?: string
  wake?: string
  raw: string
}

export interface ParsedActivity {
  key: string
  kind: ActivityKind
  start?: string
  minutes?: number
  distance?: number
  steps?: number
  raw: string
}

export interface ParsedBlock {
  key: string
  date: string
  members: string[] // メンバー名（未登録の名前も含む）
  start?: string
  end?: string
  /** 場所（「2026/11/22 エニタイムフィットネス」の後半など） */
  place?: string
  exercises: ParsedExercise[]
  sleep?: ParsedSleep
  /** 1日の歩数・歩行距離（「歩数 8234」「歩行距離 5.6km」） */
  daily?: { steps?: number; distance?: number; raw: string }
  activities: ParsedActivity[]
}

// ─────────── 睡眠・有酸素の行 ───────────
// ヘルスケアからショートカットで作ったテキスト（「睡眠 23:40-6:50 7h10m」「歩数 8234」）も読む

const RANGE_RE = /(\d{1,2}):(\d{2})\s*[-~〜–]\s*(\d{1,2}):(\d{2})/
const hm = (h: string, m: string) => `${h.padStart(2, '0')}:${m}`

const SLEEP_RE = /^(?:睡眠|すいみん|寝た|就寝|sleep)(?=[\s:：\d]|$)\s*[:：]?\s*(.*)$/i

export function parseSleepLine(line: string): ParsedSleep | null {
  const n = line.normalize('NFKC').trim()
  const m = n.match(SLEEP_RE)
  if (!m) return null
  let body = m[1]
  const out: ParsedSleep = { raw: line }
  const r = body.match(RANGE_RE)
  if (r) {
    out.bedtime = hm(r[1], r[2]); out.wake = hm(r[3], r[4])
    out.hours = hoursAcrossMidnight(out.bedtime, out.wake)
    body = body.replace(r[0], ' ')
  }
  // 実際に眠っていた時間（ヘルスケアの値）があれば、そちらを優先する
  const hmin = body.match(/(\d+(?:\.\d+)?)\s*(?:h|時間)\s*(?:(\d+)\s*(?:m|min|分))?/i)
  const onlyMin = body.match(/(\d+)\s*(?:m|min|分)(?![a-z])/i)
  const colon = body.match(/^\s*(\d{1,2}):(\d{2})\s*$/)
  const bare = body.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
  if (hmin) out.hours = Number(hmin[1]) + (hmin[2] ? Number(hmin[2]) / 60 : 0)
  else if (onlyMin) out.hours = Number(onlyMin[1]) / 60
  else if (colon) out.hours = Number(colon[1]) + Number(colon[2]) / 60
  else if (bare && Number(bare[1]) <= 24) out.hours = Number(bare[1])
  if (out.hours != null) out.hours = Math.round(out.hours * 100) / 100
  if (out.hours == null && !out.bedtime) return null
  return out
}

const ACT_RE = /^(ウォーキング|ウォーク|散歩|walk(?:ing)?|ランニング|ジョギング|ジョグ|ラン|run(?:ning)?|バイク|自転車|サイクリング|bike|歩数|steps?|歩行距離|歩行\+?ランニングの距離|距離)(?=[\s:：\d]|$)\s*[:：]?\s*(.*)$/i

export function parseActivityLine(line: string): Omit<ParsedActivity, 'key'> | null {
  const n = line.normalize('NFKC').trim()
  const m = n.match(ACT_RE)
  if (!m) return null
  const word = m[1].toLowerCase()
  let body = m[2]
  const kind: ActivityKind = /ラン(?!ニングの距離)|ジョ|run/.test(word) ? 'run' : /バイク|自転車|サイクリング|bike/.test(word) ? 'bike' : 'walk'
  const out: Omit<ParsedActivity, 'key'> = { kind, raw: line }
  const r = body.match(RANGE_RE)
  if (r) {
    out.start = hm(r[1], r[2])
    out.minutes = Math.round(hoursAcrossMidnight(out.start, hm(r[3], r[4])) * 60)
    body = body.replace(r[0], ' ')
  }
  const km = body.match(/(\d+(?:\.\d+)?)\s*(?:km|キロ)/i)
  if (km) { out.distance = Number(km[1]); body = body.replace(km[0], ' ') }
  const st = body.match(/(\d[\d,]*)\s*歩/)
  if (st) { out.steps = Number(st[1].replace(/,/g, '')); body = body.replace(st[0], ' ') }
  const h = body.match(/(\d+(?:\.\d+)?)\s*(?:時間|h)(?:\s*(\d+)\s*(?:分|min|m))?/i)
  const mi = body.match(/(\d+(?:\.\d+)?)\s*(?:分|min|m)(?![a-z])/i)
  if (h) { out.minutes = Math.round(Number(h[1]) * 60 + (h[2] ? Number(h[2]) : 0)); body = body.replace(h[0], ' ') }
  else if (mi) { out.minutes = Math.round(Number(mi[1])); body = body.replace(mi[0], ' ') }
  // 単位のない数字：「歩数 8234」は歩数、「歩行距離 3.2」はkm
  const bare = body.match(/(\d[\d,]*(?:\.\d+)?)/)
  if (bare) {
    const v = Number(bare[1].replace(/,/g, ''))
    if (/歩数|step/.test(word) && out.steps == null) out.steps = Math.round(v)
    else if (/距離/.test(word) && out.distance == null) out.distance = v
  }
  if (out.minutes == null && out.distance == null && out.steps == null) return null
  return out
}

export interface ParseResult {
  blocks: ParsedBlock[]
  ignored: string[]
}

const norm = (s: string) =>
  s.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
    // カタカナ・ひらがなの揺れ
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/ー/g, '')

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

// 打ち間違いで混ざりやすい表記（2 = to、など）も略称として持つ
const EXTRA_ALIASES: Record<string, string> = {
  UP: 'ステップアップ', STEPUP: 'ステップアップ', '2UP': 'ステップアップ', TOUP: 'ステップアップ', SU: 'ステップアップ',
  LUNGE: 'ランジ', LEGPRESS: 'レッグプレス', 'レッグプレ': 'レッグプレス',
  DEADLIFT: 'デッドリフト', SQUAT: 'スクワット', BACKSQUAT: 'バックスクワット', FRONTSQUAT: 'フロントスクワット',
  BENCH: 'ベンチプレス', BENCHPRESS: 'ベンチプレス', CLEAN: 'ハングクリーン', HANGCLEAN: 'ハングクリーン',
  ROW: 'ベントオーバーロウ', LATPULL: 'ラットプルダウン', CURL: 'ダンベルカール', PLANK: 'プランク',
  CALF: 'カーフレイズ', 'ダイアゴナル': 'ストレッチポール ダイアゴナル', CABLECRUNCH: 'ケーブルクランチ', 'ロープクランチ': 'ケーブルクランチ', 'ニーリングケーブルクランチ': 'ケーブルクランチ', 'ケーブル腹筋': 'ケーブルクランチ', PU: '懸垂', CHIN: '懸垂', PULLUP: '懸垂', DIPS: 'ディップス',
}

export function resolveName(raw: string, known: string[]): { name: string; match: ParsedExercise['match'] } {
  const q = norm(raw)
  if (!q) return { name: '', match: 'missing' }
  const dict = [...new Set([...known, ...EXERCISES.flatMap((c) => c.items)])]
  const exact = dict.find((n) => norm(n) === q)
  if (exact) return { name: exact, match: 'exact' }
  const aliases: Record<string, string> = { ...EXERCISE_ALIASES, ...EXTRA_ALIASES }
  if (aliases[q]) return { name: aliases[q], match: 'alias' }
  // 部分一致（「スクワ」→スクワット など）。候補が1つに絞れるときだけ
  const partial = dict.filter((n) => norm(n).includes(q))
  if (partial.length === 1) return { name: partial[0], match: 'fuzzy' }
  // 打ち間違い：編集距離が短いもの
  let best = '', bestD = Infinity
  for (const n of [...dict, ...Object.keys(aliases)]) {
    const d = levenshtein(q, norm(n))
    if (d < bestD) { bestD = d; best = n }
  }
  const limit = q.length <= 3 ? 1 : q.length <= 6 ? 2 : 3
  if (bestD <= limit) return { name: aliases[norm(best)] ?? best, match: 'fuzzy' }
  return { name: raw.trim(), match: 'unknown' }
}

/** 「→」でつないだ複合種目は、部分ごとに解決してつなぎ直す */
function resolveCombo(raw: string, known: string[]): { name: string; match: ParsedExercise['match'] } {
  const parts = raw.split(/→|->|＞|>/).map((p) => p.trim()).filter(Boolean)
  if (parts.length <= 1) return resolveName(raw, known)
  const whole = resolveName(raw, known)
  if (whole.match === 'exact') return whole
  const rs = parts.map((p) => resolveName(p, known))
  const rank = { exact: 0, alias: 1, fuzzy: 2, unknown: 3, missing: 4 } as const
  const worst = rs.reduce((w, r) => (rank[r.match] > rank[w] ? r.match : w), 'exact' as ParsedExercise['match'])
  return { name: rs.map((r) => r.name).join('→'), match: worst === 'exact' ? 'exact' : worst }
}

const DATE_RE = /(?:(\d{4})\s*[/\-.年]\s*)?(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?/

function parseDate(line: string, fallbackYear: number): string | null {
  const m = line.normalize('NFKC').match(DATE_RE)
  if (!m) return null
  const y = m[1] ? Number(m[1]) : fallbackYear
  const mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return toKey(new Date(y, mo - 1, d))
}

/**
 * セット表記を読む。区切り（, 、 /）ごとに「重量 回数 セット数」。
 *   "20kg 5rep 1set" "60kg×5×3" "10kg 5 3" "132kg 10回 3セット" "自重 10 3"
 */
function parseSets(text: string): SetEntry[] | null {
  const segs = text.normalize('NFKC').split(/[,、/]|\s{2,}/).map((s) => s.trim()).filter(Boolean)
  const out: SetEntry[] = []
  for (const seg of segs) {
    const s = seg.toLowerCase().replace(/[x×*]/g, ' ')
    let weight: number | undefined, reps: number | undefined, sets: number | undefined, sec: number | undefined
    const sm = s.match(/(\d+)\s*(?:秒|sec|s(?![a-z])|キープ|keep)/)
    if (sm) sec = Number(sm[1])
    const s2 = sm ? s.replace(sm[0], ' ') : s
    const w = s2.match(/(\d+(?:\.\d+)?)\s*(?:kg|ｋｇ|キロ)/)
    const r = s2.match(/(\d+)\s*(?:rep|reps|回|r\b)/)
    const st = s2.match(/(\d+)\s*(?:set|sets|セット)/)
    if (w) weight = Number(w[1])
    if (r) reps = Number(r[1])
    if (st) sets = Number(st[1])
    // 単位のない数字は「重量 回数 セット」の順で空いている所に入れる
    const rest = s2
      .replace(w?.[0] ?? '\u0000', ' ').replace(r?.[0] ?? '\u0000', ' ').replace(st?.[0] ?? '\u0000', ' ')
      .match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
    const isBodyweight = /自重|bw/.test(s) || sec != null
    for (const n of rest) {
      if (weight == null && !isBodyweight && !(reps != null && sets == null && rest.length === 1)) weight = n
      else if (reps == null) reps = n
      else if (sets == null) sets = n
    }
    if (weight == null && reps == null && sec == null) continue
    const count = Math.min(Math.max(sets ?? 1, 1), 20)
    for (let i = 0; i < count; i++) out.push(sec != null ? { weight, reps, sec } : { weight, reps })
  }
  return out.length ? out : null
}

export function parseQuickText(text: string, opts: { memberNames: string[]; knownExercises: string[]; today: string }): ParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const year = Number(opts.today.slice(0, 4))
  const blocks: ParsedBlock[] = []
  const ignored: string[] = []
  let date = opts.today
  let members: string[] = []
  let dumbbellPair = false
  // 種目名だけの行のあとに続く「数字だけの行」は、その種目のセットとして足す
  //   オーバーヘッドランジ
  //   20 10 1
  //   33 10 1
  let open: ParsedExercise | null = null
  let k = 0

  const current = (who: string[] = members) => {
    let b = [...blocks].reverse().find((x) => x.date === date && x.members.join('|') === who.join('|'))
    if (!b || (who === members && b !== blocks[blocks.length - 1])) {
      b = { key: 'b' + k++, date, members: [...who], exercises: [], activities: [], start, end, place }
      blocks.push(b)
    }
    return b
  }
  // 「k 30 10 3」「r 50 5 1、90 5 2」：人の頭文字＋数字の行は、直前の種目をその人の記録にする
  const initialOf = (t: string) => {
    const hits = opts.memberNames.filter((m) => m.normalize('NFKC').toLowerCase().startsWith(t.toLowerCase()))
    return hits.length === 1 ? hits[0] : null
  }
  let lastName: { name: string; match: ParsedExercise['match']; raw: string } | null = null
  let place: string | undefined
  const isMemberToken = (t: string) =>
    opts.memberNames.some((m) => norm(m) === norm(t)) || /^[A-Z][a-z]+$/.test(t) || /^[一-鿿]{1,4}(さん|くん|ちゃん)?$/.test(t)

  let start: string | undefined, end: string | undefined
  for (const line of lines) {
    // 睡眠・有酸素の行（時間帯の行より先に見る。「睡眠 23:40-6:50」をトレーニング時間と取り違えないため）
    const sl = parseSleepLine(line)
    if (sl) { current().sleep = sl; open = null; continue }
    const ac = parseActivityLine(line)
    if (ac && /^(歩数|steps?|歩行距離|歩行\+?ランニングの距離|距離)/i.test(line.normalize('NFKC').trim())) {
      const b = current()
      b.daily = { ...b.daily, raw: [b.daily?.raw, line].filter(Boolean).join(' / ') }
      if (ac.steps != null) b.daily.steps = ac.steps
      if (ac.distance != null) b.daily.distance = ac.distance
      open = null
      continue
    }
    if (ac) {
      const b = current()
      const same = b.activities.find((x) => x.kind === ac.kind)
      if (same) {
        // ショートカットの「歩数」「歩行距離」の行は、同じ日のウォーキングにまとめる
        for (const f of ['start', 'minutes', 'distance', 'steps'] as const) if (ac[f] != null) (same as unknown as Record<string, unknown>)[f] = ac[f]
        same.raw += ' / ' + line
      } else b.activities.push({ key: 'a' + k++, ...ac })
      open = null
      continue
    }
    // 場所の行（@エニタイム / 場所：エニタイム）
    const pl = line.normalize('NFKC').match(/^(?:@|＠|場所\s*[:：]?)\s*(.+)$/)
    if (pl) {
      place = pl[1].trim()
      blocks.forEach((b) => { if (b.date === date && !b.place) b.place = place })
      continue
    }
    // 人の頭文字＋数字（k 30 10 3）
    const ini = line.normalize('NFKC').match(/^([A-Za-z])\s+(\d.*)$/)
    const who = ini && initialOf(ini[1])
    if (ini && who && (lastName || open)) {
      const base: { name: string; match: ParsedExercise['match']; raw: string } = lastName ?? { name: open!.name, match: open!.match, raw: open!.raw }
      if (open && !open.sets.length) {
        // 種目名だけの行で作った空の記録は外し、人ごとの記録に置き換える
        blocks.forEach((b) => { b.exercises = b.exercises.filter((e) => e !== open) })
      }
      lastName = base
      open = null
      const sets = parseSets(ini[2])
      if (!sets) { ignored.push(line); continue }
      const b = current([who])
      const ex = b.exercises.find((e) => e.name === base.name)
      if (ex) { ex.sets.push(...sets); ex.raw += ' / ' + line }
      else b.exercises.push({ key: 'e' + k++, raw: `${base.raw} / ${line}`, name: base.name, match: base.match, sets })
      continue
    }
    // 時間帯の行（19:30-20:45 / 19:30〜20:45）。日付と同じ行でもよい
    const t = line.normalize('NFKC').match(/(\d{1,2}):(\d{2})\s*[-~〜–]\s*(\d{1,2}):(\d{2})/)
    if (t) {
      const dd = parseDate(line.normalize('NFKC').replace(t[0], ''), year)
      if (dd && dd !== date) { date = dd; open = null }
      start = hm(t[1], t[2]); end = hm(t[3], t[4])
      blocks.forEach((b) => { if (b.date === date && !b.start) { b.start = start; b.end = end } })
      continue
    }
    const d = parseDate(line, year)
    // 日付だけ（＋見出し語）の行
    if (d && !/\d+\s*(kg|rep|回|set|セット)/i.test(line)) {
      open = null
      lastName = null
      if (d !== date) { start = undefined; end = undefined; place = undefined }
      date = d
      const rest = line.normalize('NFKC').replace(DATE_RE, ' ').replace(/[(（][月火水木金土日][)）]/, ' ')
        .replace(/トレーニング記録|トレーニング|記録|[@＠]/g, ' ').replace(/^[\s,、:：\-–]+|[\s,、:：\-–]+$/g, '').trim()
      if (rest && !/\d/.test(rest)) {
        place = rest
        blocks.forEach((b) => { if (b.date === date && !b.place) b.place = place })
      }
      continue
    }
    // ダンベル2個の指定（2db / db×2 / ダンベル2）
    if (/^(2\s*db|db\s*[x×]?\s*2|ダンベル\s*2(個|本)?)$/i.test(line.normalize('NFKC'))) {
      dumbbellPair = true
      continue
    }
    // メンバー行：数字を含まず、区切られた全部が人名らしい
    if (!/\d/.test(line)) {
      const toks = line.split(/[,、・&＆\s]+|と(?=[A-Z一-鿿])/).map((t) => t.trim()).filter(Boolean)
      if (toks.length && toks.every(isMemberToken) && toks.every((t) => resolveName(t, opts.knownExercises).match !== 'exact')) {
        members = toks.map((t) => opts.memberNames.find((m) => norm(m) === norm(t)) ?? t)
        open = null
        lastName = null
        continue
      }
    }
    // 種目行：最初の数字の手前までを種目名とみなす
    const n = line.normalize('NFKC')
    const firstNum = n.search(/(?<![A-Za-z])\d+(?:\.\d+)?\s*(kg|キロ|rep|回|set|セット|秒|sec|キープ|s(?=[\s,、]|$)|[x×*]|\s|$)/i)
    let namePart = (firstNum >= 0 ? n.slice(0, firstNum) : n).replace(/[:：\-–]\s*$/, '').trim()
    let setsPart = firstNum >= 0 ? n.slice(firstNum) : ''
    // 「懸垂 自重 8 3」の「自重」は種目名ではなくセット側の情報
    const bw = namePart.match(/\s*(自重|BW)$/i)
    if (bw) { namePart = namePart.slice(0, bw.index).trim(); setsPart = '自重 ' + setsPart }
    const sets = setsPart ? parseSets(setsPart) : null
    if (!sets && !namePart) { ignored.push(line); continue }
    if (!sets) {
      // 種目名だけの行は、数字なしの記録として残す（確認画面で入力できる）
      const r = resolveCombo(namePart, opts.knownExercises)
      if (r.match === 'unknown' && namePart.length > 30) { ignored.push(line); continue }
      lastName = null
      open = { key: 'e' + k++, raw: line, name: r.name, match: r.match, sets: [] }
      if (dumbbellPair) {
        if (!open.name.startsWith('ダンベル')) open.name = 'ダンベル' + open.name
        open.note = 'ダンベル2個（重量は片手）'
        dumbbellPair = false
      }
      current().exercises.push(open)
      continue
    }
    if (!namePart && open) {
      open.sets.push(...sets)
      open.raw += ' / ' + line
      continue
    }
    open = null
    lastName = null
    let r = resolveCombo(namePart, opts.knownExercises)
    let note: string | undefined
    if (dumbbellPair) {
      if (r.name && !r.name.startsWith('ダンベル')) r = { ...r, name: 'ダンベル' + r.name }
      note = 'ダンベル2個（重量は片手）'
      dumbbellPair = false
    }
    current().exercises.push({ key: 'e' + k++, raw: line, name: r.name, match: r.match, sets, note })
  }
  return { blocks: blocks.filter((b) => b.exercises.length || b.sleep || b.daily || b.activities.length), ignored }
}

/** 確認画面でセットを手直しするための、往復できる短い表記 */
export const setsToText = (sets: SetEntry[]) => {
  const groups: { s: SetEntry; n: number }[] = []
  for (const x of sets) {
    const g = groups[groups.length - 1]
    if (g && g.s.weight === x.weight && g.s.reps === x.reps && g.s.sec === x.sec) g.n++
    else groups.push({ s: x, n: 1 })
  }
  return groups.map(({ s, n }) => [
    s.weight != null ? `${s.weight}kg` : s.sec == null ? '自重' : '',
    s.reps != null ? `${s.reps}回` : '',
    s.sec != null ? `${s.sec}秒` : '',
    n > 1 ? `${n}set` : '',
  ].filter(Boolean).join(' ')).join(', ')
}
export const textToSets = (t: string) => parseSets(t) ?? []
