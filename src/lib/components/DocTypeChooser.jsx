import { Drawer, Icon } from '../ui'
import { DrawerHead } from './Drawer'

/**
 * "받으신 서류가 뭔가요?" — 등록 입구에서 **처음 묻는 한 가지**.
 *
 * ── 왜 이걸 먼저 묻나 ──
 * 예전 입구는 회계 분류를 먼저 물었다. '대금 청구서'로 갈지 '일반 경비'로 갈지 사용자가
 * 정해야 했고, 그건 **"이게 매입인가 경비인가"를 먼저 판단하라**는 뜻이다. 회계 담당자가
 * 없는 회사(대표님 사모님이 보시는 곳)에서는 그 판단이 첫 관문이 된다.
 *
 * 그런데 실무는 반대 순서로 흐른다 — **서류가 먼저 손에 들어오고** 그걸 보고 기입한다.
 * 세금계산서를 받았는지, 카드전표만 있는지, 통장에서 나가기만 했는지는 **누구나 안다.**
 * 그리고 그 답이 나머지를 거의 다 결정한다:
 *   세금계산서 → 매입 청구서 + 부가세 매입세액 공제 대상
 *   카드전표·영수증 → 경비(공제 여부는 증빙 종류에 달림)
 *   없음 → 통장에서 나간 사실만
 *
 * ── 왜 메뉴를 나누지 않고 폼을 나누나 ──
 * 경비(성격)와 정기/수시(리듬)는 서로 직교한다. 경비를 메뉴로 세우면 정기 경비(임차료·
 * 서버비)가 갈 곳이 애매해지고, 정기/수시 안에 묻으면 경비가 두 군데로 흩어진다.
 * 그래서 **메뉴는 하나, 폼은 둘**이다. 입구를 하나로 두면 "돈 나간 거 어디 기록하지?"에
 * 바로 답이 되고, 폼이 갈리므로 식대 8,000원을 거래처·품목·공급가·부가세 폼으로 받는
 * 일도 없다.
 *
 * ⚠ 고른 값을 기억해 두지 않는다. 다음 건은 다른 서류일 수 있고, 기본값이 박혀 있으면
 *   확인 없이 넘어가 엉뚱한 폼에 적게 된다. 매번 묻는 편이 싸다.
 */

/** 지급(나가는 돈) — 받은 서류로 가른다 */
const PAY_OPTIONS = [
  {
    id: 'invoice', icon: Icon.Receipt,
    label: '세금계산서 · 거래명세서',
    desc: '거래처가 발행해 준 계산서가 있어요',
    effect: '매입 청구서로 등록되고 미지급금으로 잡혀요. 부가세 매입세액 공제 대상이에요.',
  },
  {
    id: 'expense', icon: Icon.Card,
    label: '카드전표 · 현금영수증 · 영수증',
    desc: '계산서 없이 결제만 했어요',
    effect: '경비로 바로 기록돼요. 청구서는 만들지 않아요.',
  },
  {
    id: 'plain', icon: Icon.Bank,
    label: '없어요 (통장에서 나가기만 함)',
    desc: '이체·자동이체처럼 서류가 없는 지출',
    effect: '나간 사실만 기록해요. 증빙이 나중에 오면 그때 붙이면 돼요.',
  },
]

/** 입금(들어오는 돈) — 청구서를 발행하는 건인지로 가른다 */
const RECEIVE_OPTIONS = [
  {
    id: 'invoice', icon: Icon.Receipt,
    label: '세금계산서를 발행해요',
    desc: '거래처에 청구서를 끊는 건',
    effect: '청구서가 발행되고 미수금으로 잡혀요. 부가세 매출세액에 들어가요.',
  },
  {
    id: 'plain', icon: Icon.Bank,
    label: '발행 없이 입금만 받아요',
    desc: '가수금 회수·이자·환급처럼 계산서가 없는 입금',
    effect: '들어온 사실만 기록해요. 미수금·부가세에는 잡히지 않아요.',
  },
]

/**
 * @param open      열림 여부
 * @param kind      'pay'(지급) | 'receive'(입금)
 * @param onPick    (id) => void — 'invoice' | 'expense' | 'plain'
 * @param onClose   닫기
 * @param canPlain  청구서 아닌 경로(경비·단순 지출)를 쓸 수 있는가
 */
export const DocTypeChooser = ({ open, kind = 'pay', onPick, onClose, canPlain = true }) => {
  const pay = kind !== 'receive'
  /* ⚠ 쓸 수 없는 경로는 **감춘다.** 예전엔 눌러도 청구서 폼으로 떨어뜨렸는데, 그건
     선택지가 약속한 것과 정반대로 동작하는 것이다 — "미수금·부가세에 잡히지 않아요"를
     읽고 고른 사용자에게 바로 그 미수금을 만드는 폼을 여는 셈이다.
     엉뚱한 회계 문서를 만드는 것보다 그 선택지가 없는 편이 낫다. */
  const options = (pay ? PAY_OPTIONS : RECEIVE_OPTIONS).filter(o => canPlain || o.id === 'invoice')

  /* confirmClose={false} — 입력 칸이 없는 '고르기' 화면이다. 기본값이면 Esc 를 눌렀을 때
     "쓰던 내용은 저장되지 않아요"가 뜨는데, 쓴 내용이 없는데 물으면 사용자는 자기가 뭘
     잃는지 몰라 멈칫한다. (VoucherView·TxnQuickDrawer 등 보기 전용 드로어와 같은 처리)
     label 은 드로어의 접근성 이름이다. */
  return (
    <Drawer open={open} onClose={onClose} confirmClose={false}
      label={pay ? '지급 등록 — 서류 선택' : '입금 등록 — 서류 선택'}>
      <DrawerHead
        title={pay ? '지급 등록' : '입금 등록'}
        sub={pay ? '받으신 서류가 무엇인가요?' : '세금계산서를 발행하는 건인가요?'}
        onClose={onClose}/>
      <div className="drawer-body col" style={{ gap: 10 }}>
        {options.map(o => (
          <button key={o.id} type="button" className="card doctype-pick"
            onClick={() => onPick(o.id)}>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span className="doctype-ico"><o.icon size={18}/></span>
              <span style={{ flex: 1, textAlign: 'left' }}>
                <span className="fw-700" style={{ display: 'block' }}>{o.label}</span>
                <span className="text-sm text-muted" style={{ display: 'block', marginTop: 2 }}>{o.desc}</span>
                {/* 회계 결과를 미리 적는다 — 고르고 나서야 알면 되돌리려고 다시 열어야 한다 */}
                <span className="text-xs text-muted2" style={{ display: 'block', marginTop: 6, lineHeight: 1.6 }}>
                  {o.effect}
                </span>
              </span>
              <Icon.Right size={16}/>
            </div>
          </button>
        ))}
        <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>
          · 어느 쪽으로 넣어도 <b>거래내역에는 함께</b> 모입니다. 나중에 바꿔야 하면 그 건을 열어 고치면 돼요.
        </div>
      </div>
    </Drawer>
  )
}
