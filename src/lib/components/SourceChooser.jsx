import { Drawer, Icon } from '../ui'
import { DrawerHead } from './Drawer'

/**
 * "무엇에서 시작할까요?" — 문서·등록의 **입구에서 처음 묻는 한 가지**.
 *
 * ── 왜 이 모양인가 ──
 * DocTypeChooser("받으신 서류가 뭔가요?")가 먼저 있었고, 그 머리말이 이유를 적어 두었다:
 * **실무는 서류가 먼저 손에 들어오고 그걸 보고 기입한다.** 회계 분류를 먼저 물으면
 * "이게 매입인가 경비인가"를 사용자가 판단해야 하는데, 그 판단이 첫 관문이 된다.
 *
 * 문서를 만드는 자리도 똑같다. 빈 폼을 먼저 열면 사용자가 거래처·금액·품목을 **손으로
 * 옮겨 적는다** — 그 값들이 이미 장부에 있는데도. 그래서 "어디서 만들까요"를 먼저 묻고,
 * 고른 출처에서 값을 끌어온다. 옮겨 적지 않으면 오타도 안 난다.
 *
 * 그 렌더링을 여기로 뽑는다. DocTypeChooser 도 이걸 쓴다 — 두 입구가 다른 모양이면
 * 사용자는 같은 질문을 두 가지로 배우게 된다.
 *
 * ⚠ 고른 값을 기억하지 않는다. 다음 건은 다른 출처일 수 있고, 기본값이 박혀 있으면
 *   확인 없이 넘어가 엉뚱한 것에서 만들게 된다. 매번 묻는 편이 싸다.
 *
 * @param options [{ id, icon, label, desc, effect }]
 *                effect — **고르면 무슨 일이 일어나는지.** 고르고 나서야 알면
 *                되돌리려고 다시 열어야 한다.
 * @param onPick  (id) => void
 * @param footer  목록 아래 한 줄(선택)
 */
export const SourceChooser = ({ open, title, sub, label, options = [], onPick, onClose, footer }) => (
  /* confirmClose={false} — 입력 칸이 없는 '고르기' 화면이다. 기본값이면 Esc 를 눌렀을 때
     "쓰던 내용은 저장되지 않아요"가 뜨는데, 쓴 내용이 없는데 물으면 사용자는 자기가 뭘
     잃는지 몰라 멈칫한다. */
  <Drawer open={open} onClose={onClose} confirmClose={false} label={label || title}>
    <DrawerHead title={title} sub={sub} onClose={onClose}/>
    <div className="drawer-body col" style={{ gap: 10 }}>
      {options.map(o => {
        const Ic = o.icon || Icon.Doc
        return (
          <button key={o.id} type="button" className="card doctype-pick" onClick={() => onPick(o.id)}>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span className="doctype-ico"><Ic size={18}/></span>
              <span style={{ flex: 1, textAlign: 'left' }}>
                <span className="fw-700" style={{ display: 'block' }}>{o.label}</span>
                <span className="text-sm text-muted" style={{ display: 'block', marginTop: 2 }}>{o.desc}</span>
                {o.effect && (
                  <span className="text-xs text-muted2" style={{ display: 'block', marginTop: 6, lineHeight: 1.6 }}>
                    {o.effect}
                  </span>
                )}
              </span>
              <Icon.Right size={16}/>
            </div>
          </button>
        )
      })}
      {footer && (
        <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>{footer}</div>
      )}
    </div>
  </Drawer>
)
