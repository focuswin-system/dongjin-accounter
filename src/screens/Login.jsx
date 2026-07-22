import { useState } from 'react'
import { Icon } from '../lib/ui'

export const LoginScreen = ({ onLogin }) => {
  // 회사코드는 마지막 로그인 값을 기억한다(같은 PC는 대개 같은 회사에서 쓴다).
  const [company, setCompany] = useState(() => localStorage.getItem('companyCode') || '');
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      onLogin({ displayName: data.user.name || data.user.username, role: data.user.role, id: data.user.id });
    } catch {
      setError('서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#fff' }}>

      {/* 좌측 브랜드 패널 */}
      <div style={{
        width: '42%',
        background: 'var(--ink)',
        display: 'flex',
        flexDirection: 'column',
        padding: '48px 44px 20px',
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        {/* 배경 장식 */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', width: 400, height: 400,
            borderRadius: '50%',
            background: 'oklch(0.52 0.15 255 / 0.12)',
            top: -120, right: -120,
          }}/>
          <div style={{
            position: 'absolute', width: 280, height: 280,
            borderRadius: '50%',
            background: 'oklch(0.52 0.15 255 / 0.07)',
            bottom: 80, left: -80,
          }}/>
          <div style={{
            position: 'absolute', width: 1, height: '60%',
            background: 'rgba(255,255,255,0.05)',
            right: 0, top: '20%',
          }}/>
        </div>

        {/* 로고 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'auto' }}>
          <span style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>
            도니도라
          </span>
        </div>

        {/* 메인 카피 */}
        <div style={{ marginBottom: 'auto' }}>
          <div style={{
            fontSize: 46, fontWeight: 800, color: '#fff',
            letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 4,
          }}>
            도니도라
          </div>
          <div style={{
            fontSize: 46, fontWeight: 800, color: '#fff',
            letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 24,
          }}>
            회계관리
          </div>
          <div style={{
            fontSize: 18, fontWeight: 500, color: 'rgba(255,255,255,0.5)',
            letterSpacing: '-0.02em', lineHeight: 1.65,
          }}>
            계약·입출금·증빙·인사까지<br/>
            전 영역을 하나의 플랫폼에서 관리하세요.
          </div>
        </div>

        {/* 하단 */}
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', letterSpacing: '-0.01em' }}>
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
