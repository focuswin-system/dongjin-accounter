import { useState, useEffect } from 'react'
import { Icon, useToast, Loading } from '../ui'
import { api } from '../api'
import { PageHeader } from './PageHeader'
import { MODES, ACCENTS, TONES, fromPrefs, toPrefs, applyTheme, writeLocal, normalize } from '../theme'

/**
 * 화면 설정 — 밝기·색·셸 톤.
 *
 * ⚠ **개인 설정이다.** 메뉴 관리와 같은 축이고, 권한(관리자가 정하는 통제)과 섞지 않는다.
 *   회사가 정할 일이 아니라 그 사람 눈이 정할 일이다.
 *
 * ⚠ 고르면 **바로 적용하고 그다음에 저장한다.** 저장을 기다렸다 적용하면 고를 때마다
 *   반 박자씩 늦어서 '먹었나?' 싶어진다. 저장이 실패하면 되돌리지 않고 알리기만 한다 —
 *   눈앞의 화면은 이미 원하는 모양이고, 다음 로그인에 안 따라올 뿐이다.
 */

const MODE_ICON = { light: Icon.Sun, dark: Icon.Moon, system: Icon.Screen }

const MODE_WHY = {
  light:  '기본. 밝은 사무실에서 가장 또렷해요.',
  dark:   '어두운 곳에서 눈이 덜 부셔요.',
  system: '컴퓨터 설정을 따라가요. 밤에 자동으로 어두워져요.',
}

/* 고른 것을 네모로 감싸는 공통 껍데기 — 모드·톤이 같은 모양이어야
   "이건 고르는 자리"라는 걸 두 번 배우지 않는다. */
const PickCard = ({ on, onClick, children, title }) => (
  <button type="button" className={`card theme-pick${on ? ' on' : ''}`} onClick={onClick} title={title}>
    {children}
  </button>
)

const Section = ({ title, desc, children }) => (
  <div className="card card-pad col" style={{ gap: 12 }}>
    <div>
      <div className="fw-700">{title}</div>
      {desc && <div className="text-sm text-muted" style={{ marginTop: 2 }}>{desc}</div>}
    </div>
    {children}
  </div>
)

export const ThemePanel = ({ embedded }) => {
  const toast = useToast()
  const [theme, setTheme] = useState(null)   // null = 불러오는 중
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.getMyPrefs().then(p => setTheme(fromPrefs(p))) }, [])

  const set = async (patch) => {
    const next = normalize({ ...theme, ...patch })
    setTheme(next)
    /* 눈에 먼저, 저장은 그다음 (위 머리말) */
    applyTheme(next); writeLocal(next)
    window.dispatchEvent(new CustomEvent('theme:changed', { detail: next }))
    setBusy(true)
    const res = await api.saveMyPrefs(toPrefs(next))
    setBusy(false)
    if (!res.ok) toast.push('이 기기에는 적용했지만 저장은 못 했어요. 다른 PC 에서는 예전 설정이에요.', { tone: 'warn' })
  }

  if (theme === null) return <Loading/>

  const darkOn = theme.mode === 'dark'

  return (
    <div className={embedded ? undefined : 'fade-up'}>
      {!embedded && <PageHeader title="화면 설정"/>}
      <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
        이 설정은 <b>나에게만</b> 적용돼요. 다른 PC 로 로그인해도 따라옵니다.
      </div>

      <div className="col gap-12" style={{ maxWidth: 720 }}>
        <Section title="밝기">
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {MODES.map(m => {
              const Ic = MODE_ICON[m.id] || Icon.Sun
              return (
                <PickCard key={m.id} on={theme.mode === m.id} onClick={() => set({ mode: m.id })}>
                  <div className="col gap-6" style={{ alignItems: 'flex-start' }}>
                    <Ic size={18}/>
                    <div className="fw-700 text-sm">{m.label}</div>
                    <div className="text-xs text-muted2" style={{ lineHeight: 1.5 }}>{MODE_WHY[m.id]}</div>
                  </div>
                </PickCard>
              )
            })}
          </div>
        </Section>

        <Section title="강조 색" desc="버튼·선택된 항목처럼 눈길을 끄는 자리에 쓰여요.">
          <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {ACCENTS.map(a => (
              <button key={a.id} type="button" title={a.label}
                className={`theme-swatch${theme.accent === a.id ? ' on' : ''}`}
                style={{ background: a.swatch }}
                onClick={() => set({ accent: a.id })}>
                {theme.accent === a.id && <Icon.Check size={14}/>}
              </button>
            ))}
            <div className="text-sm text-muted" style={{ marginLeft: 4 }}>
              {ACCENTS.find(a => a.id === theme.accent)?.label}
            </div>
          </div>
          {/* 왜 상태색은 안 바뀌는지 한 줄로. 안 적으면 "왜 마이너스는 그대로 빨강이지?" 가 남는다 */}
          <div className="text-xs text-muted2">
            들어온 돈·나간 돈·주의 표시의 색은 바뀌지 않아요. 그건 취향이 아니라 뜻이라서요.
          </div>
        </Section>

        <Section title="메뉴와 헤더"
          desc={darkOn
            ? '어둡게를 쓰는 동안에는 메뉴와 헤더도 함께 어두워요.'
            : '왼쪽 메뉴와 위쪽 헤더만 어둡게 둘 수 있어요. 본문과 확실히 갈립니다.'}>
          <div className="col gap-10" style={{ opacity: darkOn ? 0.45 : 1, pointerEvents: darkOn ? 'none' : undefined }}>
            {[['nav', '왼쪽 메뉴'], ['header', '위쪽 헤더']].map(([key, label]) => (
              <div key={key} className="row gap-10" style={{ alignItems: 'center' }}>
                <div className="text-sm fw-600" style={{ width: 90, flexShrink: 0 }}>{label}</div>
                <div className="row gap-6">
                  {TONES.map(t => (
                    <button key={t.id} type="button"
                      className={`chip${theme[key] === t.id ? ' active' : ''}`}
                      onClick={() => set({ [key]: t.id })}>{t.label}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
      {busy && <div className="text-xs text-muted2" style={{ marginTop: 10 }}>저장 중…</div>}
    </div>
  )
}
