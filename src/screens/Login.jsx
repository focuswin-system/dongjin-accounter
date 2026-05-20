import { useState } from 'react'
import { Icon } from '../lib/ui'

export const LoginScreen = ({ onLogin }) => {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!id.trim() || !pw.trim()) {
      setError('아이디와 비밀번호를 모두 입력해주세요.');
      return;
    }
    setLoading(true);
    await new Promise(r => setTimeout(r, 700));
    setLoading(false);
    if (id === 'admin' && pw === '1234') {
      onLogin({ displayName: "정대표", role: "대표이사" });
    } else {
      setError('아이디 또는 비밀번호가 올바르지 않습니다.');
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
          <img src="/src/assets/logo/logo_symbol_64.png" alt="로고"
            style={{ width: 36, height: 36, objectFit: 'contain', filter: 'brightness(0) invert(1)', opacity: 0.9 }}/>
          <span style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>
            동진테크
          </span>
        </div>

        {/* 메인 카피 */}
        <div style={{ marginBottom: 'auto' }}>
          <div style={{
            fontSize: 46, fontWeight: 800, color: '#fff',
            letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 4,
          }}>
            동진테크
          </div>
          <div style={{
            fontSize: 46, fontWeight: 800, color: '#fff',
            letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 24,
          }}>
            재무·회계관리
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
          © 2026 동진테크. All rights reserved.
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
                  autoFocus
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
