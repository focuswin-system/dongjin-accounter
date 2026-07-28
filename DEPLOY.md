# 배포 가이드 (focus-accounter)

동진테크 회계 ERP를 **focuswin 서버(192.168.0.34)** 에 다른 서비스와 격리해서 서비스한다.

## 접속 주소
- 🌐 외부(HTTPS): **https://donidora.com**  (Cloudflare 터널)
- 🏢 사무실 LAN: **http://192.168.0.34:8081**
- 로그인은 3필드: 회사코드 + 아이디 + 비밀번호
- 최초 관리자 계정 정보는 `접속정보.md`(gitignore)에. **문서·커밋에 비밀번호를 적지 말 것**

## 아키텍처 (기존 서비스 0 영향)
```
[로컬] npm run build (Vite)  →  dist/
        │ bash deploy.sh  (tar over SSH, 배포키 focuswin_deploy)
        ▼
[서버 /home/focuswin/apps/dongjin-accounter/]
  ├─ dist/            정적 SPA
  └─ server/          Express(Node20)가 dist + /api 를 8081에서 서빙
       ├─ .env        서버 전용(git 미포함): DB·PORT·JWT
       └─ uploads/    업로드(배포 시 보존)
DB: MariaDB 10.6 안의 전용 DB `winc_ac` + 전용 계정 `winc_ac`
프로세스: pm2 (dongjin-accounter + cf-tunnel), 부팅 자동기동(systemd pm2-focuswin)
외부: Cloudflare 터널 focuswin, ingress  acct.custwin.shop → localhost:8081
```
- nginx(mes)·MariaDB·방화벽·공유기 **무변경**. 포트포워딩 불필요(터널이 처리).

## 배포 (코드 바뀔 때마다)
```bash
bash deploy.sh
```
로컬 빌드 → 전송 → npm ci → pm2 reload → 헬스체크까지 자동.
전제: 배포 전용 키 `~/.ssh/focuswin_deploy` (ed25519).

## 서버 관리 (SSH)
```bash
ssh -i ~/.ssh/focuswin_deploy -p 22 focuswin@192.168.0.34
pm2 status                      # dongjin-accounter, cf-tunnel
pm2 logs dongjin-accounter
pm2 reload dongjin-accounter
```

## 주의사항
- **`.env`의 DB 비밀번호는 반드시 따옴표로** 감쌀 것: `DB_PASSWORD="<비밀번호>"`
  (비번에 `#`가 들어가면 dotenv가 주석으로 잘라먹음 → 따옴표 없으면 DB 접속 실패)
- **실제 비밀번호는 `접속정보.md`(gitignore)에만.** MariaDB root·전용 계정 모두 해당.
  전용 계정 `winc_ac`는 `winc_ac` DB에만 권한(격리).
- Cloudflare 터널을 pm2로 상시 구동 → bizai(localhost:9000) ingress도 같이 활성(앱이 떠 있으면 서비스됨).
- 코드는 MariaDB/구형 MySQL 모두 호환(utf8·TIMESTAMP 기본값). 프론트 빌드는 반드시 로컬/CI에서.

## 외부 도메인 변경 시
`~/.cloudflared/config.yml` 의 ingress hostname 수정 + `cloudflared tunnel route dns focuswin <새호스트>` 후 `pm2 restart cf-tunnel`.
