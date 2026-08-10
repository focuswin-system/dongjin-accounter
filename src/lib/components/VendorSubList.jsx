import { Icon } from '../ui'

/* 거래처의 계좌·담당자 목록 편집기.
 *
 * 왜 목록인가: 받은 실물 명세서(현진특수강) 하단에 계좌가 셋 적혀 있다
 * (기업 177-111262-01-012 / 경남 638-07-0035120 / 국민 667901-04-223797).
 * 거래처가 여러 계좌를 주고 그중 하나로 보내는 게 실제 관행이고, 담당자도 영업·경리가 갈린다.
 * 한 벌짜리 칸으로는 "이번엔 어느 계좌로 / 누구한테" 를 담을 수 없다.
 *
 * '주'는 기본값이다 — 결제 명단이 매달 집는 계좌. 매번 고르게 하면 31곳을 매달 고르는 일이 된다.
 * 그래서 주는 **하나뿐**이고, 다른 줄의 주를 켜면 이전 것이 꺼진다(둘이 주면 무엇이 기본인지 모른다).
 */
export const VendorSubList = ({ label, hint, rows = [], onChange, fields, addLabel }) => {
  const set = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const add = () => onChange([...rows, Object.fromEntries(fields.map(f => [f.key, ''])) ])
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i))
  // 주는 하나만. 켜는 줄 말고는 전부 끈다.
  const setPrimary = (i) => onChange(rows.map((r, idx) => ({ ...r, is_primary: idx === i ? 1 : 0 })))

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
        <label className="label" style={{ margin: 0 }}>
          {label} <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span>
        </label>
        <button type="button" className="btn sm ml-auto" onClick={add}>
          <Icon.Plus size={12}/> {addLabel}
        </button>
      </div>
      {hint && <div className="text-xs text-muted2" style={{ marginBottom: 8 }}>{hint}</div>}

      {rows.length === 0 ? (
        <div className="text-xs text-muted2" style={{ padding: '6px 0' }}>아직 없어요.</div>
      ) : (
        <div className="col gap-6">
          {rows.map((r, i) => (
            <div key={i} className="col gap-6"
              style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)' }}>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {fields.map(f => (
                  <input key={f.key} className={`input ${f.num ? 'num' : ''}`}
                    style={{ width: f.w, flex: f.grow ? 1 : undefined, minWidth: f.grow ? 120 : undefined }}
                    value={r[f.key] || ''} placeholder={f.ph}
                    onChange={e => set(i, { [f.key]: e.target.value })}/>
                ))}
                <button type="button" className="icon-btn" title="이 줄 삭제" onClick={() => remove(i)}>
                  <Icon.Close size={14}/>
                </button>
              </div>
              <div className="row gap-8" style={{ alignItems: 'center' }}>
                {/* 라디오처럼 동작한다 — 주는 하나뿐이다 */}
                <label className="row gap-4 text-xs" style={{ cursor: 'pointer', alignItems: 'center' }}>
                  <input type="radio" checked={!!r.is_primary} onChange={() => setPrimary(i)}/>
                  주로 씀
                </label>
                <input className="input" style={{ flex: 1, minWidth: 120 }} value={r.memo || ''}
                  placeholder="메모 (선택)" onChange={e => set(i, { memo: e.target.value })}/>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const ACCOUNT_FIELDS = [
  { key: 'bank_name',  ph: '은행',     w: 96 },
  { key: 'account_no', ph: '계좌번호', grow: true, num: true },
  { key: 'holder',     ph: '예금주',   w: 130 },
]
export const CONTACT_FIELDS = [
  { key: 'name',   ph: '이름',        w: 96 },
  { key: 'role',   ph: '직책·담당',   w: 110 },
  { key: 'phone',  ph: '전화',        w: 130, num: true },
  { key: 'mobile', ph: '휴대폰',      w: 130, num: true },
  { key: 'email',  ph: '이메일',      grow: true },
]
