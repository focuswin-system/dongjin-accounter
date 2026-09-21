import { Icon, fmtNum, Combobox } from './ui'
import { api } from './api'
import {
  C, CARD_TARGETS, guessCardColumn, mapCardRow, isCardRowValid, cardInvalidLabel,
  cardMatchKey, cardRowWarns, looksLikeBillingFile,
} from './cardStatement.js'

/* ── 카드사 이용내역(카드대금명세서) 엑셀 → 카드 사용 지출 임포트 어댑터 ──────
 *
 * 마법사 UI(파일→매핑→중복검토→등록)는 lib/components/ImportWizard.jsx 공용이고,
 * 여기엔 "카드 명세서를 어떻게 읽고 무엇을 중복으로 볼지"만 둔다.
 * 행 해석 규칙 자체는 lib/cardStatement.js(순수 함수·테스트 대상)에 있다.
 *
 * ⚠ **양식을 내려주지 않는다.** 카드사에서 받은 파일을 그대로 올리는 것이 이 기능의 요점이라
 *   양식을 만들면 오히려 "이 양식으로 옮겨 적으라"는 말이 된다 — 하려던 일이 도로 생긴다.
 */

export const cardImportAdapter = ({ cards = [], categories = [], defaultAccountId = '' } = {}) => ({
  label: '카드 사용내역',
  title: '카드 명세서 업로드',
  sub: '카드사에서 내려받은 이용내역을 그대로 올리면 카드 사용 지출로 한 번에 등록돼요. 열 이름은 카드사마다 달라도 알아서 짚어 보고, 틀리면 아래에서 고칠 수 있습니다. 승인번호가 같은 건은 다시 올려도 쌓이지 않아요.',
  targets: CARD_TARGETS,
  requiredTarget: C.date,
  requiredHelp: '이용일자와 금액이 있어야 등록할 수 있어요. 가맹점·승인번호는 없어도 되지만, 승인번호가 있으면 같은 건을 두 번 올리는 것을 막아 줍니다.',
  guess: guessCardColumn,
  parse: (file) => api.parseCardStatement(file),
  /* 카드사 사이트에는 '이용내역'과 '청구내역'이 따로 있다. 청구내역은 할부 회차별 **이번 달
     청구액**이라, 그걸 올리면 할부 원금이 회차마다 또 잡혀 경비가 부풀고 카드 잔액도 안 맞는다.
     머리글로 가려낼 수 있으면 올린 자리에서 말한다. */
  fileWarn: (headers) => (looksLikeBillingFile(headers)
    ? '청구 내역 파일 같아요. 할부가 회차마다 또 잡히니 이용내역(승인내역)을 올려주세요.'
    : null),

  commit: async (items, opts = {}) => {
    if (!opts.accountId) return { ok: false, error: '어느 카드의 명세서인지 먼저 골라주세요' }
    const r = await api.commitCardStatement(opts.accountId, items, { createVendors: !!opts.createVendors })
    if (!r.ok) return r
    const notes = []
    if (r.linkedVendors) notes.push(`${r.linkedVendors}건은 가맹점 이름·사업자번호가 맞는 기존 거래처에 연결됐어요`)
    const made = r.createdVendors || []
    if (made.length) {
      notes.push(`거래처 ${made.length}곳이 새로 등록됐어요 (${made.slice(0, 3).join(', ')}${made.length > 3 ? ' 외' : ''})`)
    }
    if (r.dupSkipped) notes.push(`승인번호가 이미 등록된 ${r.dupSkipped}건은 건너뛰었어요 — 같은 명세서를 두 번 올려도 쌓이지 않습니다`)
    if (r.skippedClosed) notes.push(`마감된 달의 ${r.skippedClosed}건은 등록하지 않았어요 — 필요하면 환경설정에서 마감을 해제하세요`)
    if (r.skippedBeforeStart) notes.push(`장부 시작일 전 ${r.skippedBeforeStart}건은 등록하지 않았어요 — 그 전 금액은 기초잔액에 이미 들어 있습니다`)
    if (r.skippedFuture) notes.push(`아직 오지 않은 날짜 ${r.skippedFuture}건은 등록하지 않았어요`)
    if (r.skippedAmount) notes.push(`금액을 읽지 못한 ${r.skippedAmount}건은 건너뛰었어요`)
    return { ...r, note: notes.join(' · ') }
  },

  /* 카드는 반드시 골라야 한다 — 이 화면에서 들어온 경우 그 카드가 기본값이다.
     비목은 비워도 등록되지만, 비우면 계정과목이 없어 일계표에서 상대 계정이 빈다.
     가맹점 거래처 등록은 **기본 꺼짐** — 켜면 거래처 목록이 가맹점으로 뒤덮인다. */
  initialOpts: { accountId: defaultAccountId, defaultCategory: '', createVendors: false },
  renderOpts: (opts, patch) => (
    <div className="col gap-12">
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">어느 카드</div>
          <div className="text-xs text-muted2">이 카드의 사용분으로 등록돼요</div>
        </div>
        <div style={{ width: 260 }}>
          <Combobox value={opts.accountId || ''} onChange={v => patch({ accountId: v })} allowAdd={false}
            options={cards.map(a => ({ value: a.id, label: a.name, sub: a.number || '' }))}
            placeholder="카드 선택"/>
        </div>
        {!opts.accountId && <span className="badge warn" style={{ fontSize: 11 }}>골라야 등록할 수 있어요</span>}
      </div>

      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">비목</div>
          <div className="text-xs text-muted2">명세서에 없는 칸이라 한 번에 정해요</div>
        </div>
        <div style={{ width: 260 }}>
          <Combobox value={opts.defaultCategory || ''} onChange={v => patch({ defaultCategory: v })} allowAdd={false}
            /* 과세 여부를 함께 보여 준다 — 명세서에 세액 열이 없으면 **이 설정대로** 들어가는데,
               안 보이면 면세 비목을 골라 놓고 "왜 매입세액이 0이지"를 나중에 묻게 된다. */
            options={[{ value: '', label: '비워 둠', sub: '나중에 거래내역에서 채우기' },
              ...categories.map(c => ({ value: c.name, label: c.name,
                sub: [c.account_code, c.vat, Number(c.vat_deductible) === 0 ? '불공제' : ''].filter(Boolean).join(' · ') }))]}
            placeholder="비목 선택"/>
        </div>
        {!opts.defaultCategory ? (
          <span className="text-xs" style={{ color: 'var(--warn-ink)' }}>
            비우면 계정과목이 없어 전표에서 상대 계정이 빕니다
          </span>
        ) : (() => {
          const c = categories.find(x => x.name === opts.defaultCategory)
          return c ? (
            <span className="text-xs text-muted2">
              명세서에 세액 칸이 없으면 이 비목 설정({c.vat || '과세'}{Number(c.vat_deductible) === 0 ? ' · 불공제' : ''})대로 들어가요
            </span>
          ) : null
        })()}
      </div>

      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">가맹점</div>
          <div className="text-xs text-muted2">이름·사업자번호가 맞으면 자동 연결</div>
        </div>
        <button className={`chip ${opts.createVendors ? 'active' : ''}`}
          onClick={() => patch({ createVendors: !opts.createVendors })}>
          {opts.createVendors ? <Icon.Check size={12}/> : null} 없는 가맹점은 거래처로 등록
        </button>
        <span className="text-xs text-muted2">
          {opts.createVendors
            ? '기존에 없는 가맹점이 매입처로 새로 등록돼요 — 가맹점이 많으면 거래처 목록이 크게 늘어납니다'
            : '거래처는 늘지 않아요 — 가맹점 이름은 적요에 남습니다'}
        </span>
      </div>
    </div>
  ),

  /* 이 업로드는 **새로 넣기만** 한다 — 기존 지출을 고치려면 거래내역에서 연다.
     덮어쓰기를 내주면 서버가 그걸 무시하고 INSERT 해 중복이 하나 더 생긴다. */
  noUpdate: true,

  mapRow: (get, opts) => mapCardRow(get, opts),
  isValid: isCardRowValid,
  invalidLabel: cardInvalidLabel,
  rowWarns: (d) => cardRowWarns(d),
  matchKey: cardMatchKey,

  /* 기존 거래와의 대조.
   *   승인번호가 같으면 **중복**이다(확실하다 — 카드사가 건마다 부여한 번호).
   *   승인번호가 없는 파일은 날짜+금액+카드로 후보만 내민다. 같은 날 같은 금액을 같은 가게에서
   *   두 번 쓰는 일이 실제로 있어서(커피 두 잔) 자동으로 건너뛰면 멀쩡한 지출이 사라진다. */
  buildIndex: (existing) => {
    const byApproval = new Map(), byKey = new Map()
    for (const t of existing) {
      const a = String(t.approvalNo || '').trim()
      if (a && !byApproval.has(a)) byApproval.set(a, t)
      const k = `${t.date}|${Number(t.amount)}`
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k).push(t)
    }
    return { byApproval, byKey }
  },
  /* ⚠ 후보는 **그 카드의 거래**로만 만든다(화면이 그렇게 넘긴다) — 모든 카드를 넣으면
     다른 카드의 같은 날 같은 금액 결제가 '확인 필요'로 잡혀 멀쩡한 지출이 조용히 빠진다. */
  findMatch: (d, idx) => {
    const a = String(d.approval_no || '').trim()
    const matched = a ? (idx.byApproval.get(a) || null) : null
    if (matched) return { matched, candidates: [] }
    return { matched: null, candidates: idx.byKey.get(`${d.date}|${Number(d.amount)}`) || [] }
  },
  candidateLabel: (t) => ({
    label: `${t.date} · ${fmtNum(t.amount)}원`,
    sub: [t.vendor || t.memo || '', t.category].filter(Boolean).join(' · ') || '이미 등록된 지출',
  }),

  previewCols: [
    { header: '이용일자', width: 96, className: 'num text-sm', render: (d) => d.date || <span className="text-neg">—</span> },
    { header: '가맹점', className: 'fw-600', render: (d) => d.merchant || <span className="text-muted2">—</span> },
    { header: '금액', className: 'num text-sm fw-600', render: (d) => fmtNum(d.amount) },
    { header: '공급가액', className: 'num text-sm text-muted', render: (d) => (d.supply_amount == null ? '—' : fmtNum(d.supply_amount)) },
    { header: '부가세', className: 'num text-sm text-muted', render: (d) => (d.vat_amount == null ? '—' : fmtNum(d.vat_amount)) },
    { header: '할부', width: 56, className: 'text-sm', render: (d) => (d.installment > 1 ? `${d.installment}개월` : '일시불') },
    { header: '승인번호', width: 130, className: 'num text-sm text-muted', render: (d) => d.approval_no || <span className="text-muted2">—</span> },
  ],

  dupHelp: (
    <><b>승인번호</b>가 이미 등록된 건은 <b>중복</b>이라 기본은 건너뜁니다 — 같은 명세서를 다시 올려도 두 번 쌓이지 않아요.
    승인번호가 없는 파일은 <b>같은 날 · 같은 금액</b>의 지출이 이미 있으면 <b>확인 필요</b>로만 표시합니다(같은 가게에서
    같은 금액을 두 번 쓰는 일이 있어 자동으로 건너뛰지 않아요).
    할부는 <b>승인일에 전액</b>으로 잡습니다 — 카드사의 '청구 내역'(회차별 청구액)을 올리면 원금이 회차마다 또 잡히니
    <b>이용내역(승인내역)</b>을 올려주세요.</>
  ),
})
