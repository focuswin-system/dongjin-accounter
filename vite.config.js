import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  // 로컬 백엔드 포트: 루트 .env의 API_PORT로 바꿀 수 있음(기본 3001).
  // 3001이 다른 프로젝트에 물려 있으면 .env에 API_PORT=3005 식으로 지정하고
  // server/.env의 PORT도 같은 값으로 맞추면 됨.
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = `http://localhost:${env.API_PORT || 3001}`
  return {
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/uploads': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: { enabled: true },
        manifest: {
          name: '도니도라 - 재무·회계관리',
          short_name: '도니도라',
          theme_color: '#0f172a',
          background_color: '#ffffff',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/web-app-manifest-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: '/favicon-96x96.png',            sizes: '96x96',   type: 'image/png' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          // 첨부 파일(/uploads)·API(/api)로의 이동은 SPA fallback(index.html)으로 가로채지 말고
          // 실제 서버로 넘긴다. 안 그러면 첨부 파일 새 탭 열기가 메인페이지로 빠진다.
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/uploads\//, /^\/api\//],
        },
      }),
    ],
  }
})
