// iOS 版（SwiftData）のモデルをそのまま写したもの。
// 日付は端末ローカルの "YYYY-MM-DD" 文字列で持つ（タイムゾーンずれを避けるため）。

export interface BodyMeasurement {
  id: string
  /** 誰の記録か（Member.id）。未設定は既定メンバー */
  memberId?: string
  date: string
  weight?: number // kg
  bodyFat?: number // %
  muscle?: number // kg
  memo: string
}

export interface PhysicalAbility {
  id: string
  /** 誰の記録か（Member.id）。未設定は既定メンバー */
  memberId?: string
  date: string
  type: string
  value: number
  unit: string
  memo: string
}

export interface SetEntry {
  weight?: number
  reps?: number
  /** キープ系の種目の秒数（プランク・ダイアゴナルなど） */
  sec?: number
}

export interface ExerciseLog {
  id: string
  name: string
  sets: SetEntry[]
}

export interface TrainingSession {
  id: string
  /** 誰の記録か（Member.id）。未設定は既定メンバー */
  memberId?: string
  date: string
  sport: string
  memo: string
  /** 開始・終了時刻（"HH:MM"）。任意 */
  start?: string
  end?: string
  /** 場所（ジム名など）。任意 */
  place?: string
  exercises: ExerciseLog[]
}

export interface ConditionRecord {
  id: string
  /** 誰の記録か（Member.id）。未設定は既定メンバー */
  memberId?: string
  date: string
  sleep?: number // 時間
  /** 就寝・起床時刻（"HH:MM"）。ヘルスケアの取り込みなどで入る。任意 */
  bedtime?: string
  wake?: string
  /** その日の歩数・歩行距離（km）。ヘルスケアの1日の合計 */
  steps?: number
  walkDistance?: number
  fatigue?: number // 1 = ほぼなし … 5 = 非常に高い
  condition?: number // 1 = 最高 … 5 = 不調
  memo: string
}

export interface Profile {
  name: string
  sport: string
}

export type PhotoPose = 'front' | 'side' | 'back'

/** 体の写真。画像本体は IndexedDB（id で引く） */
export interface BodyPhoto {
  id: string
  memberId?: string
  date: string
  pose: PhotoPose
  memo: string
}

/** ヘルスケア連携の状態（端末ごと。localStorage に保存） */
export interface HealthSync {
  connected: boolean
  memberId?: string
  lastSync?: string // ISO
}

export type ActivityKind = 'walk' | 'run' | 'bike'

/** ウォーキング・ランニングなどの有酸素の記録 */
export interface Activity {
  id: string
  memberId?: string
  date: string
  kind: ActivityKind
  /** 開始時刻（"HH:MM"）。任意 */
  start?: string
  minutes?: number
  distance?: number // km
  steps?: number
  memo: string
}

/** 記録する人。コーチが複数人の記録を取る用途のため */
export interface Member {
  id: string
  name: string
}

export interface AppData {
  version: 1
  profile: Profile
  members: Member[]
  activeMemberId: string
  bodies: BodyMeasurement[]
  abilities: PhysicalAbility[]
  sessions: TrainingSession[]
  conditions: ConditionRecord[]
  photos: BodyPhoto[]
  activities: Activity[]
}
