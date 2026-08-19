import { useState } from 'react'
import { Icon } from '../lib/ui'

/* 직전에 세션이 끊겨 되돌아왔는지 — **모듈 로드 시 한 번만** 읽는다.
 * 컴포넌트 안(useState 초기화)에서 읽고 지우면 StrictMode의 이중 마운트 때문에
 * 첫 마운트가 지워버리고 두 번째 마운트는 못 읽어서 배너가 안 뜬다. */
const KICKED = (() => {
  try {
    const raw = sessionStorage.getItem('authFail')
    if (!raw) return null
    sessionStorage.removeItem('authFail')
    return JSON.parse(raw)
  } catch { return null }
})()

/* 좌측 브랜드 패널의 색. 상호(도니도라 = 돈이 들어오다)에 맞춰 황금빛으로 간다.
 *   'gold-photo' — 받아 온 배경 이미지(금빛 물결·상승 차트). **현재 쓰는 것.**
 *   'gold-dark'  — 짙은 먹빛 바탕 + 금빛 글씨·장식. 이미지 없이 갈 때.
 *   'gold-light' — 금빛 바탕 + 먹빛 글씨. 인상은 세지만 혼자 튄다.
 * 색·배경은 index.css 의 .login-brand.<테마> 가 CSS 변수로 정한다 —
 * 여기 한 줄만 바꾸면 갈린다(JSX 는 var() 만 읽는다). */
const BRAND_THEME = 'gold-fine'

export const LoginScreen = ({ onLogin }) => {
  // 회사코드는 마지막 로그인 값을 기억한다(같은 PC는 대개 같은 회사에서 쓴다).
  const [company, setCompany] = useState(() => localStorage.getItem('companyCode') || '');
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // 직전에 세션이 끊겨 여기로 되돌아왔다면 이유를 보여준다.
  // 아무 설명 없이 로그인 화면으로 돌아오면 사용자는 '그냥 튕겼다'고만 느끼고,
  // 원인을 좁힐 단서도 남지 않는다.
  const kicked = KICKED;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!company.trim() || !id.trim() || !pw.trim()) {
      setError('회사코드·아이디·비밀번호를 모두 입력해주세요.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyCode: company.trim().toLowerCase(),
          username: id.trim(),
          password: pw,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '로그인에 실패했습니다.');
        return;
      }
      localStorage.setItem('token', data.token);
      localStorage.setItem('companyCode', data.company?.code || company.trim().toLowerCase());
      if (data.company?.name) localStorage.setItem('companyName', data.company.name);
      // mustChangePw: 관리자가 비번을 리셋한 계정 → 최초 로그인 시 비번 변경을 강제한다(App에서 게이트)
      onLogin({ displayName: data.user.name || data.user.username, role: data.user.role, id: data.user.id,
                mustChangePw: !!data.user.mustChangePw });
    } catch {
      setError('서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#fff' }}>

      {/* 좌측 브랜드 패널 — 좁은 화면에선 CSS(.login-brand)가 숨긴다 */}
      <div className={`login-brand ${BRAND_THEME}`} style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '48px 44px 32px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* 배경 장식 — 색은 .login-brand 테마가 정한다(CSS 변수) */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', width: 400, height: 400,
            borderRadius: '50%',
            background: 'var(--brand-orb-1)',
            top: -120, right: -120,
          }}/>
          <div style={{
            position: 'absolute', width: 280, height: 280,
            borderRadius: '50%',
            background: 'var(--brand-orb-2)',
            bottom: 80, left: -80,
          }}/>
          <div style={{
            position: 'absolute', width: 1, height: '60%',
            background: 'var(--brand-rule)',
            right: 0, top: '20%',
          }}/>
        </div>

        {/* 로고 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'auto' }}>
          <span style={{ color: 'var(--brand-mark)', fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>
            도니도라
          </span>
        </div>

        {/* 메인 카피 */}
        <div style={{ marginBottom: 'auto' }}>
          <div className="login-title" style={{ color: 'var(--brand-title)', marginBottom: 4 }}>
            도니도라
          </div>
          <div className="login-title" style={{ color: 'var(--brand-title-2)' }}>
            회계관리
          </div>
          <div className="login-rule"/>
          <div style={{
            fontSize: 18, fontWeight: 500, color: 'var(--brand-sub)',
            letterSpacing: '-0.02em', lineHeight: 1.65,
          }}>
            주문·입출금·증빙·인사까지<br/>
            하나의 플랫폼에서 관리하세요.
          </div>
        </div>

        {/* 하단 */}
        <div className="login-copyright" style={{ letterSpacing: '-0.01em' }}>
          © 2026 (주)포커스윈. All rights reserved.
        </div>
      </div>

      {/* 우측 폼 영역 */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 40px',
        background: '#fff',
      }}>
        <div style={{ width: '100%', maxWidth: 360 }}>

          <div style={{ marginBottom: 36 }}>
            <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--ink)', marginBottom: 8 }}>
              로그인
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>
              계정 정보를 입력하세요
            </div>
          </div>

          {kicked && (
            <div style={{
              background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 10,
              padding: '12px 14px', marginBottom: 18, fontSize: 13, lineHeight: 1.6, color: '#78350f',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>세션이 끊겨 다시 로그인이 필요해요</div>
              <div>{kicked.why || '인증이 만료되었습니다'}</div>
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>
                {kicked.method} {kicked.path}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* 회사코드 */}
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 7 }}>
                  회사코드
                </label>
                {/* placeholder에 실제 회사코드를 예시로 두지 않는다 — 타사 코드를 추측할 단서가 된다 */}
                <input
                  className="input"
                  type="text"
                  placeholder="회사코드를 입력하세요"
                  value={company}
                  onChange={e => { setCompany(e.target.value); setError(''); }}
                  autoComplete="organization"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={!company}
                  style={{ width: '100%', height: 44 }}
                />
              </div>

              {/* 아이디 */}
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 7 }}>
                  아이디
                </label>
                <input
                  className="input"
                  type="text"
                  placeholder="아이디를 입력하세요"
                  value={id}
                  onChange={e => { setId(e.target.value); setError(''); }}
                  autoComplete="username"
                  autoFocus={!!company}
                  style={{ width: '100%', height: 44 }}
                />
              </div>

              {/* 비밀번호 */}
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 7 }}>
                  비밀번호
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="input"
                    type={showPw ? 'text' : 'password'}
                    placeholder="비밀번호를 입력하세요"
                    value={pw}
                    onChange={e => { setPw(e.target.value); setError(''); }}
                    autoComplete="current-password"
                    style={{ width: '100%', height: 44, paddingRight: 44 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    style={{
                      position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 0, cursor: 'pointer',
                      color: showPw ? 'var(--ink)' : 'var(--muted-2)',
                      display: 'grid', placeItems: 'center', padding: 0,
                    }}>
                    {showPw ? <Icon.Eye size={16}/> : <Icon.EyeOff size={16}/>}
                  </button>
                </div>
              </div>

              {/* 에러 */}
              {error && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 14px', borderRadius: 10,
                  background: 'var(--neg-soft)', color: 'var(--neg-ink)',
                  fontSize: 13,
                }}>
                  <Icon.Warn size={14}/>
                  {error}
                </div>
              )}

              {/* 로그인 버튼 */}
              <button
                className="btn primary"
                type="submit"
                disabled={loading}
                style={{
                  width: '100%', height: 46, fontSize: 14, fontWeight: 700,
                  marginTop: 4, letterSpacing: '-0.01em',
                  opacity: loading ? 0.75 : 1,
                  transition: 'opacity .15s',
                }}>
                {loading
                  ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite' }}/>
                      로그인 중
                    </span>
                  : '로그인'}
              </button>

            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
