import { useState } from 'react'
import { Drawer, Icon, useToast } from '../ui'
import { DrawerHead } from './Drawer'
import { FOLDABLE_DOMAINS } from '../nav'

/* 첫 로그인 안내 — **처음 한 번만.**
 *
 * 왜 필요한가: 처음 켜면 대메뉴가 여덟 개다. 그중 우리 회사가 쓸 것과 안 쓸 것이 섞여 있는데
 * 이름만 봐서는 뭘 하는 자리인지 감이 안 온다. 그래서 "일단 다 열어두고 헤매다가" 안 쓰게 된다.
 * 무엇을 쓸지 **먼저 고르게** 하면, 고르는 동안 각 메뉴가 뭘 하는 자리인지도 함께 읽힌다.
 *
 * ⚠ 이건 **권한이 아니다.** 여기서 접은 메뉴도 데이터·권한·주소는 그대로다.
 *   Ctrl+K 와 주소로는 들어갈 수 있고, 언제든 환경설정 → 메뉴 관리에서 되살린다.
 *   그 사실을 마지막에 반드시 말한다 — 지운 줄 알면 다시 안 켠다.
 *
 * ⚠ 사람마다 다르게 저장된다(회사 단위 아님). 한 회사에서 회계담당자·영업담당자·대표가
 *   같이 쓰면 셋이 보는 메뉴가 다르다.
 *
 * 여기서 새 폼을 만들지 않는다. 하는 일은 셋뿐이다 — 소개하고, 고르게 하고, 되살리는 길을 알린다.
 */
const STEP = { INTRO: 0, PICK: 1, DONE: 2 }

export const WelcomeWizard = ({ open, userName, onClose, onSave }) => {
  const toast = useToast()
  const [step, setStep] = useState(STEP.INTRO)
  const [off, setOff] = useState([])          // 접을 대메뉴 id
  const [busy, setBusy] = useState(false)

  const toggle = (id) => setOff(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const onCount = FOLDABLE_DOMAINS.length - off.length

  const finish = async () => {
    setBusy(true)
    const res = await onSave({ nav_hidden: off, onboarded_at: new Date().toISOString() })
    setBusy(false)
    if (!res?.ok) return toast.push(res?.error || '저장에 실패했어요', { tone: 'warn' })
    setStep(STEP.DONE)
  }

  return (
    <Drawer open={open} onClose={step === STEP.DONE ? onClose : undefined} width={640}>
      <DrawerHead
        title={step === STEP.INTRO ? '도니도라에 오신 걸 환영해요'
          : step === STEP.PICK ? '어떤 일을 여기서 하시나요?'
          : '준비됐어요'}
        sub={step === STEP.INTRO ? `${userName || ''}님, 30초만 쓰면 화면이 훨씬 단순해져요.`
          : step === STEP.PICK ? '안 쓰는 건 꺼두세요. 메뉴에서만 빠지고 언제든 다시 켤 수 있어요.'
          : undefined}
        onClose={step === STEP.DONE ? onClose : undefined}/>

      <div className="drawer-body col gap-form">
        {step === STEP.INTRO && (
          <>
            <div className="card card-pad col gap-12">
              <div className="row gap-10" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center' }}>
                  <Icon.Recv size={15}/>
                </span>
                <div>
                  <div className="fw-700">돈이 들어오고 나가는 걸 적는 곳이에요</div>
                  <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                    입금·출금을 적으면 통장 잔액, 못 받은 돈, 나갈 돈이 저절로 따라옵니다.
                    이건 이 서비스의 본체라 끄지 않아요.
                  </div>
                </div>
              </div>
              <div className="row gap-10" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: 'var(--surface-3)', color: 'var(--muted)', display: 'grid', placeItems: 'center' }}>
                  <Icon.Clock size={15}/>
                </span>
                <div>
                  <div className="fw-700">매달 반복되는 건 한 번만 걸어두면 돼요</div>
                  <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                    유지보수비·임차료처럼 매달 같은 돈은 규칙으로 걸어두면 회차가 자동으로 잡힙니다.
                  </div>
                </div>
              </div>
              <div className="row gap-10" style={{ alignItems: 'flex-start' }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: 'var(--surface-3)', color: 'var(--muted)', display: 'grid', placeItems: 'center' }}>
                  <Icon.Folder size={15}/>
                </span>
                <div>
                  <div className="fw-700">나머지는 회사마다 쓰는 게 달라요</div>
                  <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                    계약·인사·세무·문서·재무·경영. 다음 화면에서 쓰실 것만 고르시면
                    나머지는 메뉴에서 접어 둘게요.
                  </div>
                </div>
              </div>
            </div>
            <div className="text-xs text-muted2">
              접어 둔 메뉴도 <b>사라지는 게 아니에요</b> — 자료는 그대로 있고, 언제든 다시 켤 수 있어요.
            </div>
          </>
        )}

        {step === STEP.PICK && (
          <>
            {/* 항상 켜지는 것을 먼저 보여준다 — 고를 수 없는 것도 '무엇이 기본인가'를 알려준다 */}
            <div className="card card-pad row gap-10" style={{ alignItems: 'center', background: 'var(--surface-2)' }}>
              <Icon.Check size={16} style={{ color: 'var(--pos-ink)', flexShrink: 0 }}/>
              <div>
                <div className="fw-700 text-sm">입출금 · 기준정보 · 환경설정</div>
                <div className="text-xs text-muted2">늘 켜져 있어요. 돈을 적는 자리와 그 바탕이 되는 자료예요.</div>
              </div>
            </div>

            {FOLDABLE_DOMAINS.map(d => {
              const on = !off.includes(d.id)
              return (
                <button key={d.id} type="button" onClick={() => toggle(d.id)}
                  className="card card-pad row gap-10"
                  style={{ alignItems: 'flex-start', textAlign: 'left', width: '100%', cursor: 'pointer',
                    borderColor: on ? 'var(--ink)' : 'var(--line)', background: '#fff',
                    fontFamily: 'inherit', opacity: on ? 1 : 0.6 }}>
                  <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1,
                    border: `1.5px solid ${on ? 'var(--ink)' : 'var(--line-strong)'}`,
                    background: on ? 'var(--ink)' : '#fff', color: '#fff', display: 'grid', placeItems: 'center' }}>
                    {on && <Icon.Check size={12}/>}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="fw-700" style={{ display: 'block' }}>{d.label}</span>
                    <span className="text-sm text-muted" style={{ display: 'block', marginTop: 2 }}>{d.why}</span>
                  </span>
                </button>
              )
            })}
            <div className="text-xs text-muted2">
              {off.length === 0
                ? '전부 켜 두셔도 괜찮아요. 나중에 정리해도 됩니다.'
                : `${off.length}개를 접어요. 메뉴에서만 빠지고 자료는 그대로예요.`}
            </div>
          </>
        )}

        {step === STEP.DONE && (
          <>
            <div className="card card-pad col gap-8" style={{ background: 'var(--pos-soft)', borderColor: 'transparent' }}>
              <div className="fw-700">메뉴를 {onCount}개로 정리했어요</div>
              <div className="text-sm">
                왼쪽 메뉴가 그만큼 단순해졌어요. 이제 <b>홈</b>의 ‘처음 세팅’을 따라
                회사 정보와 계좌·거래처를 채우시면 준비가 끝납니다.
              </div>
            </div>
            {/* 되살리는 길은 반드시 말한다 — 지운 줄 알면 다시 안 켠다 */}
            <div className="alert-row" style={{ background: 'var(--surface-2)', borderColor: 'transparent' }}>
              <Icon.Cog/>
              <div className="text-sm">
                접어 둔 메뉴는 <b>환경설정 → 메뉴 관리</b>에서 언제든 다시 켤 수 있어요.
                <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
                  접어도 자료는 지워지지 않아요. 검색(Ctrl+K)으로는 그대로 찾을 수 있습니다.
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="drawer-foot">
        {step === STEP.PICK && (
          <button className="btn" onClick={() => setStep(STEP.INTRO)} disabled={busy}>이전</button>
        )}
        <div style={{ marginLeft: 'auto' }}>
          {step === STEP.INTRO && (
            <button className="btn primary" onClick={() => setStep(STEP.PICK)}>
              시작하기 <Icon.Right size={14}/>
            </button>
          )}
          {step === STEP.PICK && (
            <button className="btn primary" onClick={finish} disabled={busy}>
              {off.length === 0 ? '전부 쓸게요' : `${onCount}개만 쓸게요`}
            </button>
          )}
          {step === STEP.DONE && (
            <button className="btn primary" onClick={onClose}>시작하기</button>
          )}
        </div>
      </div>
    </Drawer>
  )
}
