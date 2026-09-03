import { useState, useEffect } from 'react'
import { Icon, useToast, Loading } from '../ui'
import { api } from '../api'
import { PageHeader } from './PageHeader'
import { MODES, ACCENTS, NAV_MODES, fromPrefs, toPrefs, applyTheme, writeLocal, normalize } from '../theme'

/**
 * 화면 설정 — 밝기·강조색·왼쪽 메뉴 표시 방식.
 *
 * ⚠ **개인 설정이다.** 메뉴 관리와 같은 축이고, 권한(관리자가 정하는 통제)과 섞지 않는다.
 *   회사가 정할 일이 아니라 그 사람 눈이 정할 일이다.
 *
 * ⚠ 고르면 **바로 적용하고 그다음에 저장한다.** 저장을 기다렸다 적용하면 고를 때마다
 *   반 박자씩 늦어서 '먹었나?' 싶어진다. 저장이 실패하면 되돌리지 않고 알리기만 한다 —
 *   눈앞의 화면은 이미 원하는 모양이고, 다음 로그인에 안 따라올 뿐이다.
 */

const MODE_ICON = { light: Icon.Sun, dark: Icon.Moon, system: Icon.Screen }
const NAVMODE_ICON = { fixed: Icon.Menu, rail: Icon.Right, toggle: Icon.More }

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

/**
 * @param embedded 화면 제목(PageHeader)을 빼고 남의 자리 안에 들어간다
 * @param pad      여백을 **패널이 낼지**. 감싸는 쪽이 이미 여백을 주면 false.
 *
 * ⚠ 이 둘은 **다른 축**이다. 예전엔 embedded 하나가 둘 다 뜻했는데,
 *   드로어처럼 감싸는 쪽이 이미 패딩을 주는 자리에서는 여백이 **두 겹**이 됐다
 *   (프로필 설정에서 화면 설정 탭만 왼쪽이 44px, 다른 탭은 22px).
 */
export const ThemePanel = ({ embedded, pad = true }) => {
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

  return (
    /* ⚠ 환경설정 카드 안(pad)에서는 여백을 **패널이 낸다.** 그 카드는 overflow:hidden 이고
         패딩이 0이라, 글자를 모서리에 붙여 두면 첫 글자의 왼쪽이 잘려 나간다.
         반대로 드로어(pad={false})는 본문이 이미 패딩을 준다 — 여기서 또 주면 두 겹이다. */
    <div className={embedded ? (pad ? 'panel-pad' : '') : 'fade-up'}>
      {!embedded && <PageHeader title="화면 설정"/>}
      <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
        이 설정은 <b>나에게만</b> 적용돼요. 다른 PC 로 로그인해도 따라옵니다.
      </div>

      {/* ⚠ 폭 제한은 **화면으로 혼자 설 때만** 건다. 전체폭 화면에서 카드가 끝까지
          늘어나면 글이 한 줄에 너무 길어 읽기 나쁘다.
          드로어 안(embedded)에서는 서랍이 이미 폭을 정했다 — 여기서 또 720 을 걸면
          그보다 넓은 서랍에서 **오른쪽이 빈 채로 남는다.** */}
      <div className="col gap-12" style={embedded ? undefined : { maxWidth: 720 }}>
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

        <Section title="왼쪽 메뉴"
          desc="색은 밝기 설정을 따라가요. 여기서는 메뉴를 얼마나 펼쳐 둘지 고릅니다.">
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {NAV_MODES.map(n => {
              const Ic = NAVMODE_ICON[n.id] || Icon.Menu
              return (
                <PickCard key={n.id} on={theme.navMode === n.id} onClick={() => set({ navMode: n.id })}>
                  <div className="col gap-6" style={{ alignItems: 'flex-start' }}>
                    <Ic size={18}/>
                    <div className="fw-700 text-sm">{n.label}</div>
                    <div className="text-xs text-muted2" style={{ lineHeight: 1.5 }}>{n.desc}</div>
                  </div>
                </PickCard>
              )
            })}
          </div>
          {/* 좁은 화면에서는 못 지키는 약속이라 미리 말해 둔다 */}
          <div className="text-xs text-muted2">
            화면이 좁으면(태블릿·폰) 이 설정과 상관없이 ☰ 로 열려요.
          </div>
        </Section>
      </div>
      {busy && <div className="text-xs text-muted2" style={{ marginTop: 10 }}>저장 중…</div>}
    </div>
  )
}
