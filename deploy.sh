#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# focus-accounter 로컬 1방 배포 스크립트  →  focuswin 서버(192.168.0.34)
#   로컬에서 빌드 → 서버로 전송 → 원격 의존성 설치 + pm2 재시작
#   사용: bash deploy.sh
#   전제: ~/.ssh/focuswin_deploy (배포 전용 ed25519 키)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

HOST=192.168.0.34
SSH_USER=focuswin
SSH_PORT=22
APPDIR=apps/dongjin-accounter                 # 서버 홈 기준 상대경로
KEY="$HOME/.ssh/focuswin_deploy"

SSH=(ssh -i "$KEY" -p "$SSH_PORT"
     -o BatchMode=yes
     -o StrictHostKeyChecking=accept-new
     -o ConnectTimeout=20)
REMOTE="$SSH_USER@$HOST"

echo "[0/4] 테넌트 격리 검사 (로컬 — 프런트 소스가 있어야 nav 동기화까지 검사된다)"
# 원격에서도 한 번 더 돌지만, 거기엔 src/가 없어 nav 동기화 검사가 건너뛰어진다.
# 권한 카탈로그 누락을 실제로 잡으려면 여기(소스가 있는 로컬)에서 돌아야 한다.
( cd server && npm run check:isolation )

echo "[1/4] 프론트 빌드 (Vite)"
npm run build

echo "[2/4] dist 전송 (교체)"
tar czf - -C dist . \
  | "${SSH[@]}" "$REMOTE" "rm -rf ~/$APPDIR/dist && mkdir -p ~/$APPDIR/dist && tar xzf - -C ~/$APPDIR/dist"

echo "[3/4] 서버 코드 전송 (node_modules/.env/uploads/db 제외)"
tar czf - -C server \
    --exclude=node_modules --exclude=.env --exclude=uploads \
    --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
    --exclude=err.log . \
  | "${SSH[@]}" "$REMOTE" "mkdir -p ~/$APPDIR/server/uploads && tar xzf - -C ~/$APPDIR/server"

echo "[4/4] 원격 의존성 설치 + DB 스키마 준비 + pm2 재시작 + 헬스체크"
# 앱 런타임은 DDL을 하지 않는다 → 스키마 생성·마이그레이션은 배포 시점의 책임이다.
# setup-db.js는 멱등이라 매 배포마다 돌아도 안전하다(관리 계정 DB_ADMIN_USER 필요).
"${SSH[@]}" "$REMOTE" "cd ~/$APPDIR/server && \
  npm ci --omit=dev --no-audit --no-fund && \
  npm run check:isolation && \
  npm run setup:db && \
  npm run migrate:uploads && \
  pm2 startOrReload ecosystem.config.js --update-env && \
  pm2 save && \
  sleep 2 && curl -sS -m 5 http://127.0.0.1:8081/api/health && echo"
echo "✅ 배포 완료 → http://$HOST:8081  (LAN)"
