// バナー広告（Google AdMob）。iOS アプリ版だけで出す（ブラウザ版・Android 版は、まだ出さない）。
// 既存の SwiftUI 版 PhysLog と同じ App ID・広告ユニットを使う（App ID は ios/App/App/Info.plist の GADApplicationIdentifier）。
// 下のタブバーの上にバナーを置き、画面の下の余白を広告の高さだけ広げる（CSS の --ad-h）。
import { Capacitor } from '@capacitor/core'

const BANNER_UNIT = 'ca-app-pub-5619606203492593/8176736392' // 本番（既存アプリと同じ）
const TEST_BANNER_UNIT = 'ca-app-pub-3940256099942544/2934735716' // Google のテスト用

let started = false

/** アプリの起動時に1回だけ呼ぶ。失敗しても、アプリの動きには影響させない */
export async function startAds() {
  if (started || !Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return
  started = true
  try {
    const { AdMob, BannerAdPluginEvents, BannerAdPosition, BannerAdSize } = await import('@capacitor-community/admob')
    await AdMob.initialize()
    // トラッキング許可（ATT）は、起動のアニメーションと重ならないよう少し待ってから聞く。
    // 許可されなくても、広告は（パーソナライズなしで）出る
    await new Promise((r) => setTimeout(r, 1500))
    await AdMob.requestTrackingAuthorization().catch(() => {})
    await AdMob.addListener(BannerAdPluginEvents.SizeChanged, (size: { height: number }) => {
      document.documentElement.style.setProperty('--ad-h', `${Math.max(0, Math.round(size.height))}px`)
    })
    await AdMob.showBanner({
      adId: import.meta.env.DEV ? TEST_BANNER_UNIT : BANNER_UNIT,
      isTesting: import.meta.env.DEV,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      margin: tabbarHeight(),
    })
  } catch {
    document.documentElement.style.removeProperty('--ad-h')
  }
}

/** 下のタブバーの高さ（画面下の安全域を除く）。タブバーが出ていない広い画面では 0 */
function tabbarHeight(): number {
  const bar = document.querySelector<HTMLElement>('nav.tabbar')
  if (!bar || getComputedStyle(bar).display === 'none') return 0
  const button = bar.querySelector<HTMLElement>('button')
  return Math.ceil((button?.offsetHeight ?? 50) + 1) // ボタンの高さ＋上の線
}
