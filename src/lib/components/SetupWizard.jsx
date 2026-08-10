import { useState, useEffect } from 'react'
import { Icon, Drawer, Loading } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/* 첫 세팅 안내.
 *
 * 왜 필요한가: 기준정보가 비면 자동채움이 안 되고 → 손입력이 늘고 → 안 쓰게 된다.
 * 그런데 **무엇을 채워야 그게 켜지는지** 알 방법이 없었다. 메뉴는 6개 도메인이고
 * 처음 켠 사람은 "뭐부터 하지"가 된다.
 *
 * ⚠ 여기에 입력 폼을 새로 만들지 않는다. 각 단계는 **이미 있는 화면으로 보내기만** 한다.
 *   같은 폼을 두 벌 두면 반드시 어긋나고(오늘만 그 유형의 결함을 여러 번 고쳤다),
 *   마법사에서 만든 데이터와 화면에서 만든 데이터가 다른 규칙을 타게 된다.
 *   이 부품이 하는 일은 셋뿐이다 — 무엇이 비었는지 세고, 왜 필요한지 말하고, 거기로 보낸다.
 */

/* 순서에 뜻이 있다. 앞의 것이 뒤의 것을 채워준다:
   회사 정보 → 세금계산서·명세서에 우리 정보가 찍힌다
   계좌      → 입출금을 어디로 넣을지 정해진다(계좌 없는 거래는 잔액에 안 잡힌다)
   거래처    → 청구서·거래 입력에서 고를 수 있다
   품목      → 청구서 품목·계약 단가가 자동으로 채워진다
   정기청구  → 매달 반복되는 매출이 자동으로 잡힌다 */
const STEPS = [
  {
    key: 'company', label: '회사 정보', route: 'settings_company',
    why: '사업자번호·대표·주소. 세금계산서와 거래명세서에 우리 정보로 찍혀요.',
    done: (s) => s.company > 0,
    doneText: '입력됨',
    single: true,   // 한 건짜리라 '더 등록'이 아니라 '수정'이다
  },
  {
    key: 'accounts', label: '계좌 · 카드', route: 'master_account',
    why: '통장과 카드를 등록해야 입출금이 잔액에 잡혀요. 계좌 없는 거래는 어디에도 안 잡힙니다.',
    done: (s) => s.accounts > 0,
    doneText: (s) => `${s.accounts}개`,
  },
  {
    key: 'vendors', label: '거래처', route: 'master_vendor',
    why: '매출처·매입처. 청구서와 거래 입력에서 골라 쓰고, 사업자번호는 명세서에 들어가요.',
    done: (s) => s.vendors > 0,
    doneText: (s) => `${s.vendors}곳`,
    importHint: '엑셀로 한 번에 올릴 수 있어요',
  },
  {
    key: 'items', label: '품목', route: 'master_item',
    why: '팔거나 사는 것들. 등록해두면 청구서 품목·계약 단가가 자동으로 채워집니다.',
    done: (s) => s.items > 0,
    doneText: (s) => `${s.items}건`,
    importHint: '엑셀로 한 번에 올릴 수 있어요',
    optional: true,
  },
  {
    key: 'recurring', label: '정기청구', route: 'recurring_invoice',
    why: '매달 같은 금액이 나가는 매출이 있으면 걸어두세요. 회차가 자동으로 잡힙니다.',
    done: (s) => s.recurring > 0,
    doneText: (s) => `${s.recurring}건`,
    optional: true,
  },
]

/** 세팅 상태 — 홈 카드와 마법사가 같은 값을 본다. */
export const useSetupStatus = (refreshKey) => {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let alive = true
    api.getSetupStatus().then(s => { if (alive) setStatus(s) })
    return () => { alive = false }
  }, [refreshKey])
  return status
}

/** 필수 단계(선택 제외) 중 끝난 개수 */
export const setupProgress = (status) => {
  if (!status) return { done: 0, total: 0, allDone: false }
  const required = STEPS.filter(s => !s.optional)
  const done = required.filter(s => s.done(status)).length
  return { done, total: required.length, allDone: done === required.length }
}

export const SetupWizard = ({ open, onClose, onGo }) => {
  const status = useSetupStatus(open ? 1 : 0)

  return (
    <Drawer open={open} onClose={onClose} width="min(560px, 100vw)" label="첫 세팅">
      <DrawerHead title="처음 세팅하기"
        sub="여기만 채우면 나머지는 자동으로 채워져요. 순서대로 하시면 됩니다."
        onClose={onClose}/>
      <div className="drawer-body col gap-12">
        {!status ? <Loading label="확인하는 중…"/> : STEPS.map((s, i) => {
          const done = s.done(status)
          const text = typeof s.doneText === 'function' ? s.doneText(status) : s.doneText
          return (
            <div key={s.key} className="card card-pad"
              style={{ background: done ? 'var(--surface-2)' : undefined }}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                {/* 끝난 단계는 조용히 넘어간다 — 체크 하나면 충분하다 */}
                <span style={{
                  width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: done ? 'var(--pos-soft)' : 'var(--surface-3)',
                  color: done ? 'var(--pos)' : 'var(--muted)', fontSize: 12, fontWeight: 700,
                }}>
                  {done ? <Icon.Check size={14}/> : i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span className="fw-700">{s.label}</span>
                    {s.optional && <span className="text-xs text-muted2">선택</span>}
                    {done && <span className="badge pos text-xs" style={{ marginLeft: 'auto' }}>{text}</span>}
                  </div>
                  <div className="text-sm text-muted" style={{ marginTop: 4 }}>{s.why}</div>
                  {s.importHint && (
                    <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
                      <Icon.Excel size={11}/> {s.importHint}
                    </div>
                  )}
                  {/* 끝난 단계에도 **가는 길을 남긴다.**
                      한 번 채웠다고 끝이 아니다 — 거래처는 계속 늘고, 정기청구도 두 번째·세 번째를
                      걸게 된다. 예전엔 done 이면 버튼을 감춰서, 그 단계가 마법사 안에서
                      막다른 길이 됐다(9곳 있는 거래처에 10번째를 더할 길이 없었다).
                      다만 말은 달라야 한다 — 아직인 것은 '등록하러', 이미 있는 것은 '더/수정'. */}
                  <button className={`btn sm ${done ? 'ghost' : ''}`} style={{ marginTop: 10 }}
                    onClick={() => { onGo?.(s.route); onClose() }}>
                    {done
                      ? (s.single ? `${s.label} 수정` : `${s.label} 더 등록`)
                      : `${s.label} 등록하러 가기`} <Icon.Right size={12}/>
                  </button>
                </div>
              </div>
            </div>
          )
        })}

        {status && (
          <div className="text-xs text-muted2" style={{ padding: '4px 2px' }}>
            이미 쓰던 자료가 있으면 각 화면의 <b>엑셀 업로드</b>로 한 번에 올릴 수 있어요.
          </div>
        )}
      </div>
    </Drawer>
  )
}
