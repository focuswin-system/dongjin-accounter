// pm2 프로세스 정의 — 서버에서 백엔드(+정적 SPA)를 8081에서 구동.
// 포트/DB 등 환경은 같은 폴더의 .env(배포 서버 전용, git 미포함)에서 읽는다.
module.exports = {
  apps: [
    {
      name: 'dongjin-accounter',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
}
