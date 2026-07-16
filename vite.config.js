import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
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
})
