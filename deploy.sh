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

echo "[0/5] 배포 대상 확인"
# 이 스크립트는 git 을 거치지 않고 '작업 트리'를 그대로 말아 보낸다.
# 편하지만, 미커밋 변경도 조용히 운영에 올라가고 "지금 운영에 뭐가 도는지"를
# 커밋으로 답할 수 없게 된다. 그래서 (1) 올라갈 내용을 먼저 보여주고
# (2) 무엇이 올라갔는지 서버에 남긴다.
GIT_COMMIT=$(git rev-parse --short=8 HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
GIT_DIRTY_N=$(git status --porcelain | wc -l | tr -d ' ')
DEPLOY_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "  커밋: $GIT_COMMIT ($GIT_BRANCH)"

if [ "$GIT_DIRTY_N" != "0" ]; then
  echo "  ⚠ 커밋되지 않은 변경 ${GIT_DIRTY_N}건이 이 커밋 위에 얹혀 함께 배포됩니다:"
  git status --short | sed 's/^/      /' | head -20
  [ "$GIT_DIRTY_N" -gt 20 ] && echo "      … 외 $((GIT_DIRTY_N - 20))건"
  if [ "${DEPLOY_YES:-}" = "1" ]; then
    echo "  DEPLOY_YES=1 → 확인 없이 진행합니다."
  else
    # 스크립트를 파이프로 실행하는 경우에도 사람에게 물을 수 있도록 tty 를 직접 읽는다.
    printf "  그대로 진행할까요? [y/N] "
    read -r ANS < /dev/tty || ANS=""
    case "$ANS" in
      y|Y) ;;
      *) echo "  중단했습니다. (커밋 후 다시 실행하거나 DEPLOY_YES=1 로 강행)"; exit 1 ;;
    esac
  fi
  DEPLOY_DIRTY=true
else
  DEPLOY_DIRTY=false
fi

DEPLOY_INFO=$(printf '{"commit":"%s","branch":"%s","dirty":%s,"deployedAt":"%s"}' \
  "$GIT_COMMIT" "$GIT_BRANCH" "$DEPLOY_DIRTY" "$DEPLOY_AT")

echo "[1/5] 테넌트 격리 검사 (로컬 — 프런트 소스가 있어야 nav 동기화까지 검사된다)"
# 원격에서도 한 번 더 돌지만, 거기엔 src/가 없어 nav 동기화 검사가 건너뛰어진다.
# 권한 카탈로그 누락을 실제로 잡으려면 여기(소스가 있는 로컬)에서 돌아야 한다.
( cd server && npm run check:isolation )

echo "[2/5] 프론트 빌드 (Vite)"
npm run build

echo "[3/5] dist 전송 (교체)"
tar czf - -C dist . \
  | "${SSH[@]}" "$REMOTE" "rm -rf ~/$APPDIR/dist && mkdir -p ~/$APPDIR/dist && tar xzf - -C ~/$APPDIR/dist"

echo "[4/5] 서버 코드 전송 (node_modules/.env/uploads/db 제외)"
# ⚠ 새 코드는 스키마보다 **먼저** 디스크에 올라간다(마이그레이션이 새 코드 안에 있으니 순서를 뒤집을 수 없다).
#   그 사이에 setup:db 가 실패하면 "새 코드 + 옛 스키마"가 디스크에 남는다. pm2 는 autorestart 라
#   무슨 이유로든 프로세스가 죽으면 그 조합으로 기동한다 — 전면 500 이다.
#   그래서 덮어쓰기 직전 코드를 server.prev 에 떠 두고, 아래 [5/5] 에서 실패하면 되돌린다.
"${SSH[@]}" "$REMOTE" "mkdir -p ~/$APPDIR/server && rm -rf ~/$APPDIR/server.prev && mkdir -p ~/$APPDIR/server.prev && tar cf - -C ~/$APPDIR/server --exclude=node_modules --exclude=uploads . | tar xf - -C ~/$APPDIR/server.prev"
tar czf - -C server \
    --exclude=node_modules --exclude=.env --exclude=uploads \
    --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
    --exclude=err.log . \
  | "${SSH[@]}" "$REMOTE" "mkdir -p ~/$APPDIR/server/uploads && tar xzf - -C ~/$APPDIR/server"

echo "[5/5] 원격 의존성 설치 + DB 스키마 준비 + pm2 재시작 + 헬스체크"
# 앱 런타임은 DDL을 하지 않는다 → 스키마 생성·마이그레이션은 배포 시점의 책임이다.
# setup-db.js는 멱등이라 매 배포마다 돌아도 안전하다(관리 계정 DB_ADMIN_USER 필요).
# setup:db 실패는 배포를 중단시킨다(스키마가 코드와 안 맞으면 기동해도 500이 난다).
# 반면 migrate:uploads 실패로 pm2 재시작을 막으면 "새 코드는 전송됐는데 구 프로세스가 계속 도는"
# 더 나쁜 상태가 되므로, 경고만 남기고 배포는 계속한다.
# deploy-info.json 은 pm2 재시작 '전에' 쓴다 — 서버는 기동할 때 이 파일을 한 번 읽어
# /api/health 로 노출한다. 재시작 뒤에 쓰면 다음 배포까지 옛 정보가 보인다.
"${SSH[@]}" "$REMOTE" "cd ~/$APPDIR/server && \
  { npm ci --omit=dev --no-audit --no-fund && \
    npm run check:isolation && \
    npm run setup:db; } || { \
      echo '❌ 의존성·스키마 준비 실패 — 전송한 코드를 배포 전으로 되돌립니다(서비스는 그대로 돕니다)'; \
      tar cf - -C ~/$APPDIR/server.prev . | tar xf - -C ~/$APPDIR/server; \
      exit 1; \
    } && \
  { npm run migrate:uploads || echo '⚠ migrate:uploads 실패 — 첨부 경로 확인 필요(배포는 계속)'; } && \
  echo '$DEPLOY_INFO' > deploy-info.json && \
  pm2 startOrReload ecosystem.config.js --update-env && \
  pm2 save && \
  sleep 2 && curl -sS -m 5 http://127.0.0.1:8081/api/health && echo"
echo "✅ 배포 완료 → http://$HOST:8081  (LAN)"
echo "   올라간 것: $GIT_COMMIT ($GIT_BRANCH)$([ "$DEPLOY_DIRTY" = true ] && echo ' + 미커밋 변경' || true)"
