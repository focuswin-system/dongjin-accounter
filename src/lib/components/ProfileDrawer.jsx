import { useState, useEffect, useRef } from 'react'
import { Icon, useToast, Drawer } from '../ui'
import { DrawerHead, DrawerFooter } from './Drawer'
import { ThemePanel } from './ThemePanel'
import { api } from '../api'

/**
 * 내 프로필 — 사진·내 정보·비밀번호·접속 이력·화면 설정.
 *
 * ── 왜 환경설정이 아니라 여기인가 ──
 * 환경설정은 **회사** 설정이라 `settings` 권한 뒤에 있다. 그런데 비밀번호 변경과
 * 화면 설정(밝기·강조색)은 **누구나** 해야 하는 일이다. 환경설정에 두면
 * 그 권한을 안 받은 실무 계정은 **자기 비밀번호도 못 바꾸고 다크 모드도 못 켠다.**
 * 그래서 계정 자리(헤더 오른쪽 유저 패널) 아래에 둔다 — 화면이 어디든 같은 자리다.
 *
 * ⚠ 여기서 바꿀 수 있는 것은 **내 것뿐**이다. 아이디·역할·소속은 신원이라 마스터가 정한다
 *   (스스로 역할을 올릴 수 있으면 권한 체계가 없는 것과 같다 — 서버도 막는다).
 */

const TABS = ['내 정보', '비밀번호', '접속 이력', '화면 설정']

export const ProfileDrawer = ({ open, onClose, user, onSaved }) => {
  const toast = useToast()
  const [tab, setTab] = useState('내 정보')
  const [me, setMe] = useState(null)
  const [form, setForm] = useState({ name: '', email: '' })
  const [avatar, setAvatar] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  // 비밀번호
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')

  // 접속 이력 — 탭을 열 때만 부른다(늘 부르면 프로필 열 때마다 조회가 하나 더 돈다)
  const [logins, setLogins] = useState(null)

  useEffect(() => {
    if (!open) return
    setTab('내 정보'); setPw1(''); setPw2(''); setLogins(null)
    api.me().then(m => {
      setMe(m)
      setForm({ name: m?.name || '', email: m?.email || '' })
      setAvatar(m?.prefs?.avatar_url || '')
    }).catch(() => {})
  }, [open])

  useEffect(() => {
    if (open && tab === '접속 이력' && logins === null) api.getMyLogins(30).then(setLogins)
  }, [open, tab, logins])

  const pickPhoto = async (file) => {
    if (!file) return
    if (!/^image\//.test(file.type)) return toast.push('사진 파일만 올릴 수 있어요', { tone: 'warn' })
    setBusy(true)
    const up = await api.uploadFile(file)
    setBusy(false)
    if (!up?.url) return toast.push('사진을 올리지 못했어요', { tone: 'warn' })
    /* 주소만 개인 설정에 담는다 — 파일 자체는 기존 업로드 경로가 회사 폴더에 넣는다 */
    const r = await api.saveMyPrefs({ avatar_url: up.url })
    if (!r.ok) return toast.push(r.error || '사진을 저장하지 못했어요', { tone: 'warn' })
    setAvatar(up.url)
    onSaved?.({ avatarUrl: up.url })
    toast.push('사진을 바꿨어요')
  }

  const removePhoto = async () => {
    const r = await api.saveMyPrefs({ avatar_url: null })
    if (!r.ok) return toast.push(r.error || '지우지 못했어요', { tone: 'warn' })
    setAvatar('')
    onSaved?.({ avatarUrl: '' })
    toast.push('사진을 지웠어요')
  }

  const saveInfo = async () => {
    setBusy(true)
    const r = await api.saveMyProfile({ name: form.name, email: form.email })
    setBusy(false)
    if (!r.ok) return toast.push(r.error || '저장하지 못했어요', { tone: 'warn' })
    onSaved?.({ displayName: r.name })
    toast.push('내 정보를 저장했어요')
  }

  const savePw = async () => {
    if (pw1.length < 4) return toast.push('비밀번호는 4자 이상이어야 해요', { tone: 'warn' })
    if (pw1 !== pw2) return toast.push('두 번 입력한 비밀번호가 달라요', { tone: 'warn' })
    setBusy(true)
    const r = await api.changeMyPassword(me?.id || user?.id, pw1)
    setBusy(false)
    if (!r.ok) return toast.push(r.error || '바꾸지 못했어요', { tone: 'warn' })
    /* 서버가 새 토큰을 주면 갈아 끼운다 — 임시 비번으로 들어온 경우 옛 토큰에는
       mustChangePw 가 남아 있어 다음 요청부터 막힌다. */
    if (r.token) localStorage.setItem('token', r.token)
    setPw1(''); setPw2('')
    toast.push('비밀번호를 바꿨어요')
  }

  const initial = (form.name || user?.displayName || '?')[0]

  /* 서랍 폭 — 접속 이력이 표(시각·결과·IP)이고 화면 설정이 카드 여럿이라 560 은 좁다.
     문서 드로어(720)와 같은 폭으로 맞춘다. 같은 앱에서 서랍 폭이 제각각이면 어수선하다. */
  return (
    <Drawer open={open} onClose={onClose} width="min(720px, 100vw)" label="프로필 설정">
      <DrawerHead title="프로필 설정" sub={me ? `${me.company_name} · ${me.username}` : ''} onClose={onClose}/>

      <div className="tab-bar" style={{ padding: '0 18px' }}>
        {TABS.map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      <div className="drawer-body">
        {tab === '내 정보' && (
          <div className="col gap-16">
            {/* 사진 — 없으면 이름 첫 글자. 헤더 아바타와 같은 규칙이라 둘이 늘 같아 보인다 */}
            <div className="row gap-16" style={{ alignItems: 'center' }}>
              <div className="avatar" style={{ width: 64, height: 64, fontSize: 24, overflow: 'hidden', flexShrink: 0 }}>
                {avatar
                  ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                  : initial}
              </div>
              <div className="col gap-6">
                <div className="row gap-8">
                  <button className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                    <Icon.Upload size={13}/> 사진 올리기
                  </button>
                  {avatar && <button className="btn sm ghost" onClick={removePhoto}>지우기</button>}
                </div>
                <div className="text-xs text-muted2">jpg·png · 정사각형에 가까울수록 잘 보여요</div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => { pickPhoto(e.target.files?.[0]); e.target.value = '' }}/>
            </div>

            <div>
              <label className="label">이름 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <input className="input" value={form.name} placeholder="예: 홍길동"
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}/>
            </div>
            <div>
              <label className="label">이메일 <span className="text-muted2">(선택)</span></label>
              <input className="input" value={form.email} placeholder="예: hong@company.co.kr"
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}/>
            </div>

            {/* 못 바꾸는 것들 — 왜 못 바꾸는지 적는다. 안 적으면 '고장'으로 읽힌다 */}
            <div className="card card-pad col gap-8" style={{ background: 'var(--surface-2)' }}>
              <div className="row"><span className="text-sm text-muted">아이디</span>
                <span className="text-sm fw-600 ml-auto">{me?.username || '—'}</span></div>
              <div className="row"><span className="text-sm text-muted">역할</span>
                <span className="text-sm fw-600 ml-auto">{me?.role === 'admin' ? '마스터' : '일반 사용자'}</span></div>
              <div className="row"><span className="text-sm text-muted">회사</span>
                <span className="text-sm fw-600 ml-auto">{me?.company_name || '—'}</span></div>
              <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
                아이디·역할·소속은 회사 마스터가 정해요. 바꾸려면 관리자에게 요청하세요.
              </div>
            </div>
          </div>
        )}

        {tab === '비밀번호' && (
          <div className="col gap-16">
            <div>
              <label className="label">새 비밀번호 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <input className="input" type="password" value={pw1} placeholder="4자 이상"
                onChange={e => setPw1(e.target.value)}/>
            </div>
            <div>
              <label className="label">새 비밀번호 확인 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <input className="input" type="password" value={pw2} placeholder="다시 한 번"
                onChange={e => setPw2(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') savePw() }}/>
            </div>
            <div className="text-xs text-muted2">
              바꾸면 이 기기의 로그인은 유지되고, 다른 기기에서는 새 비밀번호로 다시 들어와야 해요.
            </div>
          </div>
        )}

        {tab === '접속 이력' && (
          <div className="col gap-12">
            <div className="text-sm text-muted">
              내 계정으로 들어온 기록이에요. <b>모르는 접속</b>이 있으면 비밀번호를 바꾸세요.
            </div>
            {logins === null
              ? <div className="text-sm text-muted2" style={{ padding: 16 }}>불러오는 중…</div>
              : logins.length === 0
                ? <div className="text-sm text-muted2" style={{ padding: 16 }}>기록이 없어요.</div>
                : (
                  <div className="table-scroll">
                    <table className="table">
                      <thead><tr><th>시각</th><th>결과</th><th>접속 IP</th></tr></thead>
                      <tbody>
                        {logins.map((l, i) => (
                          <tr key={i}>
                            <td className="num text-sm">{String(l.at).replace('T', ' ').slice(0, 19)}</td>
                            {/* 정상엔 표식을 달지 않는다 — 눈에 띄어야 하는 건 실패한 쪽이다 */}
                            <td>{l.ok ? <span className="text-sm text-muted2">성공</span>
                                      : <span className="badge neg" style={{ fontSize: 11 }}>실패</span>}</td>
                            <td className="num text-sm text-muted">{l.ip || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
          </div>
        )}

        {/* 화면 설정은 **같은 부품**을 그대로 쓴다 — 환경설정 화면과 두 벌이 되면 안 된다 */}
        {tab === '화면 설정' && <ThemePanel embedded/>}
      </div>

      {/* 화면 설정·접속 이력은 누르는 즉시 반영·조회라 저장 버튼이 없다 */}
      {(tab === '내 정보' || tab === '비밀번호') && (
        <DrawerFooter
          onCancel={onClose} cancelLabel="닫기"
          onSave={tab === '내 정보' ? saveInfo : savePw}
          saveLabel={tab === '내 정보' ? '저장' : '비밀번호 바꾸기'}
          saveDisabled={busy || (tab === '내 정보' ? !form.name.trim() : !(pw1 && pw2))}/>
      )}
    </Drawer>
  )
}
