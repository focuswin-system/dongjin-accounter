import { useState, useEffect } from 'react'
import { Icon, useToast } from '../ui'
import { FOLDABLE_DOMAINS } from '../nav'

/* 첫 로그인 안내 — **처음 한 번만.**
 *
 * 왜 필요한가: 처음 켜면 대메뉴가 여덟 개다. 그중 우리 회사가 쓸 것과 안 쓸 것이 섞여 있는데
 * 이름만 봐서는 뭘 하는 자리인지 알기 어렵다. 무엇을 쓸지 **먼저 고르게** 하면,
 * 고르는 동안 각 메뉴가 무슨 일을 하는지도 함께 읽힌다.
 *
 * ⚠ **드로어가 아니라 전면 화면이다.** 옆에서 슬쩍 나오는 서랍은 '지금 하던 일에 곁들이는 것'의
 *   모양이다. 이건 서비스의 첫인상이라 화면 전체를 쓰고, 한 번에 한 가지만 묻는다.
 *
 * ⚠ 문구는 **담백하게.** 처음 만나는 화면에서 과하게 친근한 설명조("~하는 곳이에요",
 *   "저절로 따라옵니다")는 회계 도구의 첫인상으로 유치하게 읽힌다. 사실을 짧게 적는다.
 *
 * ⚠ 이건 권한이 아니다. 여기서 접은 메뉴도 자료·권한·주소는 그대로다.
 *   언제든 환경설정 → 메뉴 관리에서 되살린다 — 그 사실을 마지막에 반드시 말한다.
 */
const STEP = { INTRO: 0, PICK: 1, DONE: 2 }

const INTRO_POINTS = [
  { icon: Icon.Recv, title: '입출금',
    desc: '입금·출금을 기록하면 통장 잔액, 미수금, 지급 예정이 함께 산출됩니다.' },
  { icon: Icon.Clock, title: '정기 거래',
    desc: '유지보수비·임차료처럼 반복되는 건은 규칙으로 등록하면 회차가 자동으로 잡힙니다.' },
  { icon: Icon.Folder, title: '그 밖의 영역',
    desc: '계약·인사·세무·문서·재무·경영은 회사마다 쓰는 범위가 다릅니다. 다음 단계에서 고릅니다.' },
]

export const WelcomeWizard = ({ open, userName, onClose, onSave }) => {
  const toast = useToast()
  const [step, setStep] = useState(STEP.INTRO)
  const [off, setOff] = useState([])
  const [busy, setBusy] = useState(false)

  /* 열려 있는 동안 뒤 화면이 스크롤되면 안 된다 — 전면 화면인데 뒤가 움직이면
     덮은 게 아니라 떠 있는 것처럼 보인다. */
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
    setStep(STEP.DONE)
  }

  const skip = async () => {
    setBusy(true)
    await onSave({ onboarded_at: new Date().toISOString() })
    setBusy(false)
    onClose()
  }

  return (
    <div className="wz">
      <div className="wz-inner">
        {/* 단계 표시 — 몇 걸음 남았는지 알면 끝까지 간다 */}
        <div className="wz-dots">
          {[0, 1, 2].map(i => <span key={i} className={`wz-dot${i === step ? ' on' : ''}${i < step ? ' done' : ''}`}/>)}
        </div>

        {step === STEP.INTRO && (
          <div key="intro" className="wz-stage">
            <div className="wz-head">
              <div className="wz-title">{userName ? `${userName}님, ` : ''}도니도라를 시작합니다</div>
              <div className="wz-sub">쓰실 기능만 골라 화면을 정리합니다. 30초면 끝납니다.</div>
            </div>
            <div className="wz-stagger wz-points">
              {INTRO_POINTS.map((p, i) => {
                const Ic = p.icon
                return (
                  <div key={i} className="wz-point">
                    <span className="wz-point-ico"><Ic size={20}/></span>
                    <div>
                      <div className="wz-point-title">{p.title}</div>
                      <div className="wz-point-desc">{p.desc}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {step === STEP.PICK && (
          <div key="pick" className="wz-stage">
            <div className="wz-head">
              <div className="wz-title">어떤 업무를 여기서 하시나요</div>
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
              입출금·기준정보·환경설정은 늘 켜져 있습니다.
            </div>
          </div>
        )}

        {step === STEP.DONE && (
          <div key="done" className="wz-stage wz-stage-center">
            <span className="wz-done-mark"><Icon.Check size={30}/></span>
            <div className="wz-head">
              <div className="wz-title">준비됐습니다</div>
              <div className="wz-sub">
                {off.length === 0
                  ? '모든 메뉴를 켜 둔 상태로 시작합니다.'
                  : `${off.length}개 메뉴를 접어 왼쪽이 그만큼 단순해졌습니다.`}
              </div>
            </div>
            <div className="wz-stagger wz-points" style={{ maxWidth: 520 }}>
              <div className="wz-point">
                <span className="wz-point-ico"><Icon.Check size={20}/></span>
                <div>
                  <div className="wz-point-title">다음은 기초 자료</div>
                  <div className="wz-point-desc">홈의 ‘처음 세팅’에서 회사 정보·계좌·거래처를 채우면 준비가 끝납니다.</div>
                </div>
              </div>
              {/* 되살리는 길은 반드시 말한다 — 지운 줄 알면 다시 안 켠다 */}
              <div className="wz-point">
                <span className="wz-point-ico"><Icon.Cog size={20}/></span>
                <div>
                  <div className="wz-point-title">접은 메뉴는 언제든 되살립니다</div>
                  <div className="wz-point-desc">환경설정 → 메뉴 관리. 접어도 자료는 지워지지 않고, 검색으로는 계속 찾을 수 있습니다.</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="wz-foot">
          {step === STEP.PICK && (
            <button className="btn" onClick={() => setStep(STEP.INTRO)} disabled={busy}>이전</button>
          )}
          {step !== STEP.DONE && (
            <button className="btn ghost" onClick={skip} disabled={busy}>나중에 하기</button>
          )}
          <div style={{ marginLeft: 'auto' }}>
            {step === STEP.INTRO && (
              <button className="btn primary wz-cta" onClick={() => setStep(STEP.PICK)}>
                시작하기 <Icon.Right size={15}/>
              </button>
            )}
            {step === STEP.PICK && (
              <button className="btn primary wz-cta" onClick={finish} disabled={busy}>
                {off.length === 0 ? '모두 사용' : `${onCount}개 사용`}
              </button>
            )}
            {step === STEP.DONE && (
              <button className="btn primary wz-cta" onClick={onClose}>들어가기</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
