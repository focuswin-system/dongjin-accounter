import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/* 개발 서버에 남아 있는 서비스워커를 **스스로 없애는** 워커를 내려준다.
 *
 * ── 왜 필요한가 ──
 * 예전에 devOptions.enabled 가 켜져 있어 5173에도 PWA 워커가 등록됐다. 그 워커는
 * index.html·번들을 선캐시해 두고 네트워크를 안 본다. 그래서 코드를 아무리 고쳐도
 * **그 탭에서는 옛 화면이 그대로 나온다**(시크릿탭은 워커가 없어서 정상 동작한다).
 *
 * 설정만 끄면 더 나쁘다 — /dev-sw.js 가 404가 되어 옛 워커는 **갱신할 새 워커조차
 * 못 받고** 영원히 옛 캐시를 붙든다. 사용자에게 DevTools를 열어 지우게 할 수는 없다.
 *
 * 그래서 같은 경로에 '자폭 워커'를 둔다. 브라우저는 페이지를 열 때마다 워커 스크립트가
 * 바뀌었는지 확인하는데, 그때 이걸 받아 설치하고 → 캐시를 전부 지우고 → 스스로 등록을
 * 해제하고 → 열려 있는 탭을 새로고침한다. 사용자는 평소처럼 새로고침만 하면 된다.
 */
const KILL_SW = `
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k)
    await self.registration.unregister()
    const tabs = await self.clients.matchAll({ type: 'window' })
    for (const t of tabs) t.navigate(t.url)   // 새 번들로 다시 불러온다
  })())
})
`.trim()

const killServiceWorker = () => ({
  name: 'kill-stale-service-worker',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const p = (req.url || '').split('?')[0]
      if (p === '/dev-sw.js' || p === '/sw.js') {
        res.setHeader('Content-Type', 'application/javascript')
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        return res.end(KILL_SW)
      }
      next()
    })
  },
})

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
      // react()보다 먼저 — 워커 요청을 가로채야 한다
      killServiceWorker(),
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        // 개발 서버(5173)에서는 서비스워커를 끈다.
        // 켜두면 워커가 index.html·번들을 선캐시해서, 코드를 고치고 새로고침해도 **옛 화면**이
        // 그대로 나온다. 고쳤는데 안 고쳐진 것처럼 보이고, 옛 번들이 옛 토큰 흐름을 타면
        // 로그인하자마자 튕기는 것처럼 보인다. 운영 빌드의 PWA 동작은 그대로다.
        devOptions: { enabled: false },
        manifest: {
          name: '도니도라 - 회계관리',
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
