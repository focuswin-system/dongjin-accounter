import { useState, useEffect } from 'react'
import { Combobox, DateInput, localToday } from '../ui'
import { api } from '../api'
import { bizTypeOptions, bizItemOptions } from '../bizTypes'

/* 회사 정보 입력 구획 — **첫 설정 화면과 환경설정 › 회사 정보가 같은 부품을 쓴다.**
 *
 * 같은 칸을 두 화면에 따로 그리면 반드시 어긋난다(한쪽에만 칸이 늘거나, 검사 규칙이 달라진다).
 * 검사·계산은 서버가 한다(lib/companyChange.js, lib/bizNo.js, lib/fiscal.js). 여기는 그리기만 한다.
 *
 * form 은 서버 칸 이름(snake_case) 그대로 — 저장할 때 옮겨 담다 칸을 빠뜨리지 않게.
 * errors 는 { 칸이름: 문구 } — 서버가 준 field 로 그 칸 아래에 붙인다.
 */

/* 한 줄 — 이름 열 + 값 열.
   ⚠ 부품 **안**에서 정의하면 안 된다. 렌더마다 새 컴포넌트 타입이 되어
     input 이 통째로 다시 붙고, 한 글자 칠 때마다 포커스가 날아간다. */
export const CoRow = ({ label, req, hint, error, children }) => (
  <div className="co-row">
    <div className="co-key">{label}{req && <span style={{ color: 'var(--neg-ink)' }}> *</span>}</div>
    <div style={{ minWidth: 0 }}>
      {children}
      {error
        ? <div className="co-hint" style={{ color: 'var(--neg-ink)' }}>{error}</div>
        : hint && <div className="co-hint">{hint}</div>}
    </div>
  </div>
)

export const emptyCompanyForm = () => ({
  name: '', biz_no: '', sub_biz_no: '', ceo: '', biz_type: '', biz_item: '',
  address: '', phone: '', fax: '', email: '',
  fiscal_end_month: 12, fiscal_base_seq: '', books_start: '',
})

/** 서버 행 → 폼. 기수는 **올해 회기의 기수**로 받는다(저장된 기준 기수가 아니라 서버가 계산한 fiscal.seq) */
export const companyFormOf = (c) => {
  const base = emptyCompanyForm()
  if (!c) return base
  const out = { ...base }
  for (const k of Object.keys(base)) {
    if (c[k] !== null && c[k] !== undefined) out[k] = c[k]
  }
  out.fiscal_end_month = Number(c.fiscal_end_month) || 12
  out.fiscal_base_seq = c.fiscal?.seq ?? ''
  return out
}

/* 오류가 난 칸으로 데려간다 — 저장 버튼이 긴 화면 맨 아래라 토스트만으로는 어느 칸인지 안 보인다 */
export const focusCompanyField = (field) => {
  const el = document.getElementById(`co-${field}`)
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.focus({ preventScroll: true })
  return true
}

const errStyle = (on) => (on ? { borderColor: 'var(--neg)' } : undefined)

/* ── 사업자 정보 ── */
export const BizSection = ({ form, f, errors = {} }) => (
  <div className="card card-pad col co-sec" style={{ gap: 14 }}>
    <div className="co-head">사업자 정보</div>
    <CoRow label="상호" req error={errors.name}>
      <input id="co-name" className="input" value={form.name} style={errStyle(errors.name)}
        onChange={e => f('name', e.target.value)} placeholder="예: 도니도라 주식회사"/>
    </CoRow>
    <CoRow label="사업자번호" req error={errors.biz_no}>
      <input id="co-biz_no" className="input num" value={form.biz_no} inputMode="numeric" maxLength={12}
        style={errStyle(errors.biz_no)} onChange={e => f('biz_no', e.target.value)} placeholder="예: 000-00-00000"/>
    </CoRow>
    <CoRow label="종사업장번호" hint="있을 때만 — 숫자 4자리" error={errors.sub_biz_no}>
      <input id="co-sub_biz_no" className="input num" value={form.sub_biz_no} inputMode="numeric" maxLength={4}
        style={{ maxWidth: 120, ...errStyle(errors.sub_biz_no) }}
        onChange={e => f('sub_biz_no', e.target.value.replace(/\D/g, ''))} placeholder="예: 0001"/>
    </CoRow>
    <CoRow label="대표자" error={errors.ceo}>
      <input id="co-ceo" className="input" value={form.ceo} style={errStyle(errors.ceo)} onChange={e => f('ceo', e.target.value)} placeholder="예: 홍길동"/>
    </CoRow>
    {/* 업태·종목은 사업자등록증에 적힌 문구를 그대로 옮기는 칸이다. 자유 입력이라
        같은 뜻을 여러 표기로 쓰게 되므로(소프트웨어개발/소프트웨어 개발/SW개발)
        표준 목록에서 고르게 하되, 목록에 없으면 직접 입력도 된다. */}
    <CoRow label="업태" error={errors.biz_type}>
      <Combobox value={form.biz_type} onChange={v => f('biz_type', v)}
        options={bizTypeOptions()} placeholder="선택 또는 직접 입력"
        onAddNew={q => f('biz_type', q)} addNewLabel="직접 입력"/>
    </CoRow>
    <CoRow label="종목" error={errors.biz_item}>
      <Combobox value={form.biz_item} onChange={v => f('biz_item', v)}
        options={bizItemOptions(form.biz_type)} placeholder="선택 또는 직접 입력"
        onAddNew={q => f('biz_item', q)} addNewLabel="직접 입력"/>
    </CoRow>
  </div>
)

/* ── 연락처·주소 ── */
export const ContactSection = ({ form, f, errors = {} }) => (
  <div className="card card-pad col co-sec" style={{ gap: 14 }}>
    <div className="co-head">연락처 · 주소</div>
    <CoRow label="사업장 주소" error={errors.address}>
      <input id="co-address" className="input" value={form.address} style={errStyle(errors.address)} onChange={e => f('address', e.target.value)} placeholder="예: 경기도 안산시 ..."/>
    </CoRow>
    <CoRow label="대표 전화" error={errors.phone}>
      <input id="co-phone" className="input" value={form.phone} style={errStyle(errors.phone)} onChange={e => f('phone', e.target.value)} placeholder="예: 031-000-0000"/>
    </CoRow>
    <CoRow label="팩스" error={errors.fax}>
      <input id="co-fax" className="input" value={form.fax} style={errStyle(errors.fax)} onChange={e => f('fax', e.target.value)} placeholder="예: 031-000-0001"/>
    </CoRow>
    <CoRow label="이메일" error={errors.email}>
      <input id="co-email" className="input" value={form.email} style={errStyle(errors.email)} onChange={e => f('email', e.target.value)} placeholder="예: info@company.co.kr"/>
    </CoRow>
  </div>
)

const STD_MONTHS = [3, 6, 9, 12]
const dot = (d) => String(d || '').replace(/-/g, '.')

/* ── 회기 ──
 * 결산월과 **올해 회기의 기수**만 받는다(사용자 확정 2026-09-15 — 회계연도 칸 없음, 기수는 선택).
 * 올해 회기의 기간·이름은 서버가 계산해 보여준다. */
/* onCarryover — 이월 잔액 서랍 열기(환경설정 › 회사 정보에서만). 장부 시작일이 **저장돼** 있어야 연다 —
   이월 잔액의 날짜가 시작일 전날이라서(서버 routes/invoices.js /carryover) */
export const FiscalSection = ({ form, f, errors = {}, savedBooksStart = '', onCarryover = null }) => {
  const month = Number(form.fiscal_end_month) || 12
  /* '직접입력'은 누른 것 **또는** 값이 3·6·9·12 가 아닌 것. 누른 것만 상태로 두면
     회사 정보를 나중에 불러와 5월이 들어왔을 때 어느 칩도 안 켜진 채 값이 숨는다. */
  const [customPicked, setCustomPicked] = useState(false)
  const isStd = STD_MONTHS.includes(month)
  // 칩 불빛은 **저장될 값**을 따른다 — '직접입력'을 눌러도 달을 고르기 전엔 지금 값(예: 12월) 칩이 켜져 있어야 거짓말을 안 한다
  const showPicker = customPicked || !isStd
  const [period, setPeriod] = useState(null)

  useEffect(() => {
    let alive = true
    api.getFiscalPreview({ endMonth: month }).then(r => { if (alive) setPeriod(r?.error ? null : r) })
    return () => { alive = false }
  }, [month])

  return (
    <div className="card card-pad col co-sec" style={{ gap: 14 }}>
      <div className="co-head">회기</div>
      <CoRow label="결산월" error={errors.fiscal_end_month}>
        <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
          {STD_MONTHS.map(m => (
            <button key={m} type="button" className={`chip ${month === m ? 'active' : ''}`}
              onClick={() => { setCustomPicked(false); f('fiscal_end_month', m) }}>{m}월</button>
          ))}
          <button type="button" className={`chip ${!isStd ? 'active' : ''}`} onClick={() => setCustomPicked(true)}>직접입력</button>
        </div>
        {showPicker && (
          <div style={{ marginTop: 8, maxWidth: 160 }}>
            <Combobox value={isStd ? '' : String(month)} allowAdd={false}
              onChange={v => { if (Number(v)) f('fiscal_end_month', Number(v)) }}
              options={Array.from({ length: 12 }, (_, i) => i + 1).filter(m => !STD_MONTHS.includes(m))
                .map(m => ({ value: String(m), label: `${m}월` }))}
              placeholder="결산월"/>
          </div>
        )}
      </CoRow>
      <CoRow label="올해 회기">
        <div style={{ padding: '10px 0', fontVariantNumeric: 'tabular-nums' }}>
          {period ? `${dot(period.start)} ~ ${dot(period.end)} (${period.name})` : '—'}
        </div>
      </CoRow>
      <CoRow label="기수" hint="모르면 비워 두세요" error={errors.fiscal_base_seq}>
        <div className="row gap-6" style={{ alignItems: 'center' }}>
          <span className="text-sm text-muted">제</span>
          <input id="co-fiscal_base_seq" className="input num" value={form.fiscal_base_seq} inputMode="numeric" maxLength={3}
            style={{ maxWidth: 90, ...errStyle(errors.fiscal_base_seq) }}
            onChange={e => f('fiscal_base_seq', e.target.value.replace(/\D/g, ''))} placeholder="예: 5"/>
          <span className="text-sm text-muted">기</span>
        </div>
      </CoRow>
      {/* 장부 시작일(4단계) — 쓰기 시작한 날. 계좌 기초잔액이 이날 아침 잔액이 되고, 그 전 날짜의 거래는 막힌다
          (같은 돈이 기초잔액과 거래로 두 번 잡히지 않게). 비우면 막는 것이 없다. */}
      <CoRow label="장부 시작일" hint="선택 · 계좌 기초잔액이 이날 아침 잔액이에요" error={errors.books_start}>
        <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <DateInput id="co-books_start" className="input" style={{ maxWidth: 170, ...errStyle(errors.books_start) }}
            max={localToday()} value={form.books_start || ''} onChange={e => f('books_start', e.target.value)}/>
          {onCarryover && savedBooksStart && (
            <button type="button" className="link-cell text-sm" onClick={onCarryover}>
              쓰기 전부터 있던 미수·미지급(이월 잔액) →
            </button>
          )}
        </div>
        {form.books_start && (
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {dot(form.books_start)} 전 입금·출금은 마감된 달처럼 잠겨요. 그 전 돈은 기초잔액·이월 잔액에 넣어 주세요.
          </div>
        )}
      </CoRow>
    </div>
  )
}
