import type { CapacitorConfig } from '@capacitor/cli'

// iOS / Android アプリとして包む設定。端末のヘルスケア（HealthKit / Health Connect）を読むため。
// appId は既存の SwiftUI 版（com.ryotabani.PhysLog）と分けている。差し替えるときはここと各ネイティブ設定を変える
const config: CapacitorConfig = {
  appId: 'com.ryotabani.physlog.app',
  appName: 'PhysLog',
  webDir: 'dist-app',
}

export default config
