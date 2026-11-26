import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 通常ビルド: docs/app/ に出力（GitHub Pages で /PhysLog/app/ として配信）
// single モード: 1ファイルの HTML（プレビュー共有用）
// app モード: iOS / Android アプリ（Capacitor）に入れる用。dist-app/ に出力
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  // 手元の記録（seed.json）は、プレビュー版（single）にだけ入れる。アプリ版・公開版には空のファイルを入れる
  // （使わなくても、読み込むだけで中身がファイルに同梱されてしまうため）
  resolve: mode === 'single' ? undefined : {
    alias: [{ find: /^\.\/seed\.json$/, replacement: fileURLToPath(new URL('./src/seed.empty.json', import.meta.url)) }],
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : mode === 'app' ? 'dist-app' : '../docs/app',
    emptyOutDir: true,
  },
}))
