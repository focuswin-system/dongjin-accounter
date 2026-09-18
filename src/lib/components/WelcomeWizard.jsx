import { useState, useEffect } from 'react'
import { Icon, useToast } from '../ui'
import { FOLDABLE_DOMAINS } from '../nav'

/* 첫 로그인 안내 — **처음 한 번만, 한 장.**
 *
 * 왜 필요한가: 처음 켜면 대메뉴가 여럿이다. 그중 우리 회사가 쓸 것과 안 쓸 것이 섞여 있는데
 * 이름만 봐서는 뭘 하는 자리인지 알기 어렵다. 무엇을 쓸지 **먼저 고르게** 하면,
 * 고르는 동안 각 메뉴가 무슨 일을 하는지도 함께 읽힌다.
 *
 * ⚠ 한 장만 둔다(2026-09 단순화). 예전엔 소개 → 고르기 → 완료 세 장이었는데,
 *   '시작'을 두 번 누르게 하고, 완료 장의 "다음은 기초 자료"는 홈의 처음 세팅 카드와 같은 말이었다.
 *   회사 정보는 이 앞의 첫 설정 화면(CompanySetup)이 이미 받았다.
 *
 * ⚠ 드로어가 아니라 전면 화면이다 — 서비스의 첫인상이라 화면 전체를 쓴다.
 * ⚠ 이건 권한이 아니다. 여기서 접은 메뉴도 자료·권한·주소는 그대로다.
 *   언제든 환경설정 → 메뉴 관리에서 되살린다 — 그 사실을 반드시 말한다.
 */
export const WelcomeWizard = ({ open, userName, initialOff, replay, onClose, onSave }) => {
  const toast = useToast()
  const [off, setOff] = useState([])
  const [busy, setBusy] = useState(false)

  /* 열릴 때마다 **지금 접혀 있는 그대로**를 보여주고 시작한다 — 다시 보기로 열었을 때
     이전에 고른 상태가 남아 있으면 지금 화면과 다른 말을 한다. */
  useEffect(() => {
    if (!open) return
    setOff(Array.isArray(initialOff) ? initialOff : [])
  }, [open])

  /* 열려 있는 동안 뒤 화면이 스크롤되면 덮은 게 아니라 떠 있는 것처럼 보인다 */
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const toggle = (id) => setOff(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const onCount = FOLDABLE_DOMAINS.length - off.length

  const finish = async () => {
    setBusy(true)
    const res = await onSave({ nav_hidden: off, onboarded_at: new Date().toISOString() })
    setBusy(false)
    if (!res?.ok) return toast.push(res?.error || '저장에 실패했습니다', { tone: 'warn' })
    if (off.length) toast.push(`${off.length}개 메뉴를 접었어요 — 환경설정 › 메뉴 관리에서 되살릴 수 있어요`)
    onClose()
  }

  /* 첫 실행에서는 '나중에' 를 눌러도 끝난 것으로 표시한다 — 안 그러면 다음 로그인에 또 뜬다.
     다시 보기로 연 경우에는 이미 끝난 것이라 그냥 닫는다. */
  const skip = async () => {
    if (replay) return onClose()
    setBusy(true)
    await onSave({ onboarded_at: new Date().toISOString() })
    setBusy(false)
    onClose()
  }

  return (
    <div className="wz">
      <div className="wz-inner">
        <div className="wz-stage">
          <div className="wz-head">
            <div className="wz-title">{userName ? `${userName}님, ` : ''}어떤 업무를 여기서 하시나요</div>
            <div className="wz-sub">안 쓰는 항목은 꺼두세요. 메뉴에서만 빠지고 자료는 그대로 남습니다.</div>
          </div>
          <div className="wz-stagger wz-grid">
            {FOLDABLE_DOMAINS.map(d => {
              const on = !off.includes(d.id)
              const Ic = d.icon
              return (
                <button key={d.id} type="button" onClick={() => toggle(d.id)}
                  className={`wz-card${on ? ' on' : ''}`}>
                  <span className="wz-card-ico">{Ic ? <Ic size={22}/> : <Icon.Folder size={22}/>}</span>
                  <span className="wz-card-title">{d.label}</span>
                  <span className="wz-card-desc">{d.why}</span>
                  <span className="wz-card-check">{on && <Icon.Check size={13}/>}</span>
                </button>
              )
            })}
          </div>
          <div className="wz-note">
            입출금·기준정보·환경설정은 늘 켜져 있습니다. 접은 메뉴는 환경설정 › 메뉴 관리에서 언제든 되살립니다.
          </div>
        </div>

        <div className="wz-foot">
          <button className="btn ghost" onClick={skip} disabled={busy}>{replay ? '닫기' : '나중에 하기'}</button>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn primary wz-cta" onClick={finish} disabled={busy}>
              {off.length === 0 ? '모두 사용' : `${onCount}개 사용`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
