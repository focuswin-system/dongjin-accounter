import { Icon, Combobox } from '../ui'
import { MAIN_BADGE } from '../mainAccount'

/**
 * 계좌·카드 고르기 — **몇 개 없으면 칩, 많으면 검색되는 목록.**
 *
 * 계좌 하나가 칩 하나라서, 계좌가 늘면 칩이 줄을 바꿔 쌓였다 — 9개에 세 줄, 20~30개면 폼 절반을 덮는다
 * (2026-09-29 사용자: "계좌가 엄청 늘어나면 어떻게 돼?"). 짧은 목록은 칩, 긴 목록은 콤보박스(메모리 규칙).
 *
 *   ≤ chipLimit  칩 — 한 번 눌러 고른다(지금까지와 같다)
 *   > chipLimit  콤보박스 — 이름·은행·번호로 찾는다
 *
 * ⚠ 순서는 부르는 쪽이 정한다(withMainFirst — 주거래가 맨 앞). 여기서 다시 정렬하지 않는다.
 * ⚠ **미리 고르지 않는다** — 주거래를 자동으로 골라 두면 확인 없이 지나가 다른 통장 돈이 주거래로 적힌다
 *   (lib/mainAccount.js 머리말의 사고). 앞에 세우고 표시만 한다.
 *
 * @param accounts  [{ id, name, label?, bankName?, number?, kind }] — 보일 순서 그대로
 * @param value     고른 값(valueKey 에 해당하는 값)
 * @param valueKey  'id' | 'name' — 부르는 폼이 계좌를 무엇으로 들고 있나
 * @param isMain    (a) => boolean — 주거래 표시
 * @param icon      'bank' | 'card'
 */
export const AccountPicker = ({ accounts = [], value, onChange, valueKey = 'id', isMain = () => false,
  icon = 'bank', chipLimit = 6, placeholder = '계좌 선택', empty = null, portal = false }) => {
  const Ico = icon === 'card' ? Icon.Card : Icon.Bank
  const labelOf = (a) => a.label || a.name
  if (accounts.length === 0) return empty
  if (accounts.length <= chipLimit) {
    return (
      <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
        {accounts.map(a => (
          <button key={a.id} type="button" className={`chip ${value === a[valueKey] ? 'active' : ''}`}
            onClick={() => onChange(a[valueKey], a)}>
            <Ico size={12}/>{labelOf(a)}
            {/* 왜 맨 앞인지 말해주지 않으면 "왜 순서가 이렇지"가 된다 */}
            {isMain(a) && <span className="text-muted2" style={{ fontSize: 10, marginLeft: 3 }}>{MAIN_BADGE}</span>}
          </button>
        ))}
      </div>
    )
  }
  return (
    /* portal — 스크롤 상자 안(표 펼침 줄 등)에서 목록이 잘리지 않게 맨 위층에 띄운다. 팝업 안은 Combobox 가 알아서 켠다 */
    <Combobox value={value || ''} allowAdd={false} placeholder={placeholder} portal={portal}
      onChange={v => onChange(v, accounts.find(a => a[valueKey] === v))}
      options={accounts.map(a => ({
        value: a[valueKey],
        label: labelOf(a),
        sub: [isMain(a) ? MAIN_BADGE : '', a.kind === 'card' ? '카드' : a.bankName || a.bank, a.number].filter(Boolean).join(' · '),
      }))}/>
  )
}
