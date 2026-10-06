import { Icon, fmtNum, Combobox } from './ui'
import { api } from './api'
import { accountLabels } from './accountLabel'
import {
  C, CARD_TARGETS, guessCardColumn, mapCardRow, isCardRowValid, cardInvalidLabel, resolveCard,
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

export const cardImportAdapter = ({ cards = [], categories = [], employees = [], defaultAccountId = '' } = {}) => {
  // 카드 칸을 찾을 목록 — 이름이 겹치는 카드엔 끝자리가 붙은 이름(서버 양식의 '카드 목록'과 같은 글자)
  const cardList = accountLabels(cards).map(l => ({ ...l, number: cards.find(c => c.id === l.id)?.number || '' }))
  const cardLabel = (id) => cardList.find(c => c.id === id)?.label || ''
  return {
  label: '카드 사용내역',
  title: '카드 명세서 엑셀 업로드',
  sub: '카드 사용분을 양식에 맞춰 한 번에 등록해요. 카드사에서 다운로드한 이용내역도 열을 매핑해 올릴 수 있어요.',
  /* 양식 — 2026-10-02 사용자: "카드 명세서 업로드도 우리가 양식을 준비하자".
     카드사 파일엔 없는 **비목·공제 여부·사용 직원·차량** 칸이 있다. 카드사 파일을 그대로 올리는 길도 그대로 둔다
     (머리글이 달라도 열 매핑). ⚠ 머리글은 C(lib/cardStatement.js)와 같은 글자 — 서버 양식(routes/transactions.js)도 */
  templateUrl: '/api/transactions/import/card-template',
  templateName: '카드사용_업로드_양식.xlsx',
  guide: {
    intro: <>양식의 열 제목 그대로 올리면 <b>열 매핑 없이</b> 바로 검토 단계로 넘어갑니다.<br/>
      카드사에서 다운로드한 이용내역도 올릴 수 있어요 — 이 경우 열을 직접 매핑합니다.</>,
    note: <><b>첫 행(열 제목)은 수정하지 마세요.</b> 카드·비목·공제 여부·사용 직원은 ▼ 목록에서 고르세요.<br/>
      카드가 여러 장이면 한 파일에 적어도 됩니다 — 카드 칸이 빈 줄은 업로드 화면에서 고른 카드로 들어가요.<br/>
      공제 여부는 용도로 갈립니다 — 같은 주유·하이패스도 차량에 따라 다를 수 있어요. 비우면 비목 설정을 따릅니다.<br/>
      카드사 파일은 <b>청구내역이 아니라 이용내역</b>을 올려 주세요(할부가 회차마다 다시 잡혀요).</>,
    downloadHint: '회사 비목·직원 목록 포함',
    rows: [
      { col: C.date,     req: true, how: '이용한 날 (결제일 아님)', ex: '2026-09-15', num: true },
      { col: C.card,     how: '목록에서 선택 — 비우면 업로드 화면에서 고른 카드', ex: '국민카드-공용' },
      { col: C.amount,   req: true, how: '부가세 포함 결제 금액', ex: '57,700', num: true },
      { col: C.merchant, how: '쓴 곳 — 거래처로 연결(없으면 적요에 남음)', ex: 'SK에너지 성산주유소' },
      { col: `${C.supply} · ${C.vat}`, how: '영수증 값. 비우면 비목 설정대로 계산', ex: '52,455 · 5,245', num: true },
      { col: C.deductible, how: '공제 / 불공제 — 비우면 비목 설정', ex: '불공제' },
      { col: C.category, how: '목록에서 선택 — 비우면 업로드 화면에서 지정', ex: '차량유지비' },
      { col: C.employee, how: '목록에서 선택', ex: '홍길동' },
      { col: C.vehicle,  how: '차량번호·차종 — 적요에 남음', ex: '12가 3456 (스타렉스)' },
      { col: C.memo,     how: '용도 등 자유 입력', ex: '거제 현장 출장' },
      { col: C.approval, how: '같은 건 두 번 등록 방지', ex: '30012345', num: true },
    ],
  },
  vendorOf: (d) => d.merchant,
  bizOf: (d) => d.biz_no,
  withVendor: (d, name) => ({ ...d, merchant: name }),
  // 가맹점 거래처 등록을 켰을 때만 새 거래처가 생긴다
  vendorPlanOn: (opts) => !!opts.createVendors,
  // 등록 불가 줄에서 틀린 칸만(취소 건은 고칠 것이 아니다 — 원거래를 지우는 일이다)
  fixFields: (d) => (d.canceled ? [] : [
    !d.date && { key: 'date', label: '이용일자', kind: 'date' },
    !d.account_id && { key: 'account_id', label: '카드', kind: 'select', options: cardList.map(c => ({ value: c.id, label: c.label, sub: c.number })) },
    !(Number(d.amount) > 0) && { key: 'amount', label: '이용금액', kind: 'money' },
  ].filter(Boolean)),
  compareCols: [
    ['날짜', t => t.date, true], ['금액', t => fmtNum(t.amount), true], // 거래처가 없으면 '(미확인)' 대신 적요(가맹점) — 카드 화면의 규칙과 같다
    ['가맹점·적요', t => (t.vendorId ? t.vendor : t.memo) || '—'],
    ['비목', t => t.category || '—'], ['승인번호', t => t.approvalNo || '—', true],
  ],
  unclearHelp: '거래처로 연결하지 못한 가맹점 — 이름은 적요에 남았어요',
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
    // 카드는 줄마다 정해져 있다(카드 칸 → 없으면 화면에서 고른 카드). 못 정한 줄은 미리보기에서 이미 '등록 불가'다
    const r = await api.commitCardStatement(opts.accountId || '', items, { createVendors: !!opts.createVendors })
    if (!r.ok) return r
    /* 연결·새 거래처·건너뛴 줄(중복·취소·마감·미래·금액)은 결과 화면이 줄마다 보여 준다 — 여기엔 그 밖의 일만 */
    const notes = []
    if (r.skippedClosed) notes.push('마감 월 줄은 등록하지 않았어요 — 필요하면 환경설정에서 마감을 해제하세요')
    if (r.skippedBeforeStart) notes.push('장부 시작일 전 금액은 기초잔액에 이미 들어 있어 등록하지 않았어요')
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
          <div className="text-xs text-muted2">카드 칸이 빈 줄에 적용돼요</div>
        </div>
        <div style={{ width: 260 }}>
          <Combobox value={opts.accountId || ''} onChange={v => patch({ accountId: v })} allowAdd={false}
            options={cardList.map(a => ({ value: a.id, label: a.label, sub: a.number || '' }))}
            placeholder="카드 선택"/>
        </div>
      </div>

      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">비목</div>
          <div className="text-xs text-muted2">비목 칸이 빈 줄에 적용돼요</div>
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

  mapRow: (get, opts) => {
    const d = mapCardRow(get, opts)
    const hit = resolveCard(d.card_text, cardList)
    return { ...d, account_id: hit === null ? (opts.accountId || '') : (hit || ''), card_unknown: hit === false }
  },
  isValid: (d) => isCardRowValid(d) && !!d.account_id,
  invalidLabel: (d) => (!isCardRowValid(d) ? cardInvalidLabel(d)
    : d.card_unknown ? `목록에 없는 카드 '${d.card_text}'` : '카드를 고르세요'),
  rowWarns: (d) => [
    ...cardRowWarns(d),
    // 목록에 없는 비목은 계정과목이 안 붙는다 / 없는 직원은 이름만 남는다 — 등록은 되지만 미리 알린다
    ...(d.category && categories.length && !categories.some(c => c.name === d.category) ? [`비목 '${d.category}'이(가) 목록에 없어요`] : []),
    ...(d.employee_name && employees.length && !employees.some(e => e.name === d.employee_name) ? [`직원 '${d.employee_name}'이(가) 목록에 없어 이름만 남아요`] : []),
  ],
  // 파일 안 중복도 **같은 카드끼리만**
  matchKey: (d) => `${d.account_id}|${cardMatchKey(d)}`,

  /* 기존 거래와의 대조.
   *   승인번호가 같으면 **중복**이다(확실하다 — 카드사가 건마다 부여한 번호).
   *   승인번호가 없는 파일은 날짜+금액+카드로 후보만 내민다. 같은 날 같은 금액을 같은 가게에서
   *   두 번 쓰는 일이 실제로 있어서(커피 두 잔) 자동으로 건너뛰면 멀쩡한 지출이 사라진다. */
  buildIndex: (existing) => {
    const byApproval = new Map(), byKey = new Map()
    for (const t of existing) {
      const a = String(t.approvalNo || '').trim()
      if (a && !byApproval.has(`${t.accountId}|${a}`)) byApproval.set(`${t.accountId}|${a}`, t)
      const k = `${t.accountId}|${t.date}|${Number(t.amount)}`
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k).push(t)
    }
    return { byApproval, byKey }
  },
  /* ⚠ 후보는 **그 줄의 카드 거래**로만 만든다(키에 카드가 들어 있다) — 카드를 안 가리면
     다른 카드의 같은 날 같은 금액 결제가 '확인 필요'로 잡혀 멀쩡한 지출이 조용히 빠진다. */
  findMatch: (d, idx) => {
    const a = String(d.approval_no || '').trim()
    const matched = a ? (idx.byApproval.get(`${d.account_id}|${a}`) || null) : null
    if (matched) return { matched, candidates: [] }
    return { matched: null, candidates: idx.byKey.get(`${d.account_id}|${d.date}|${Number(d.amount)}`) || [] }
  },
  candidateLabel: (t) => ({
    label: `${t.date} · ${fmtNum(t.amount)}원`,
    sub: [t.vendor || t.memo || '', t.category].filter(Boolean).join(' · ') || '이미 등록된 지출',
  }),

  previewCols: [
    { header: '이용일자', width: 96, className: 'num text-sm', render: (d) => d.date || <span className="text-neg">—</span> },
    { header: '카드', className: 'text-sm', render: (d) => (d.account_id ? cardLabel(d.account_id)
      : <span className="text-neg">{d.card_text || '—'}</span>) },
    { header: '가맹점', className: 'fw-600', render: (d) => d.merchant || <span className="text-muted2">—</span> },
    // 할부는 드물어 칸을 따로 두지 않는다 — 할부일 때만 금액 옆에(칸이 많아 '처리'가 화면 밖으로 밀렸다)
    { header: '금액', className: 'num text-sm fw-600', render: (d) => <>{fmtNum(d.amount)}{d.installment > 1 && <span className="text-xs text-muted2" style={{ marginLeft: 4, fontWeight: 400 }}>{d.installment}개월</span>}</> },
    { header: '공급가액', className: 'num text-sm text-muted', render: (d) => (d.supply_amount == null ? '—' : fmtNum(d.supply_amount)) },
    { header: '부가세', className: 'num text-sm text-muted', render: (d) => (d.vat_amount == null ? '—' : fmtNum(d.vat_amount)) },
    { header: '비목', className: 'text-sm', render: (d) => d.category || <span className="text-muted2">—</span> },
    // 공제는 정상(비목 설정)엔 표시하지 않는다 — 직접 정한 것만
    { header: '공제', width: 64, className: 'text-sm', render: (d) => (d.vat_deductible === 0 ? <span className="badge warn" style={{ fontSize: 10 }}>불공제</span>
      : d.vat_deductible === 1 ? '공제' : <span className="text-muted2">—</span>) },
    { header: '사용 직원', className: 'text-sm', render: (d) => d.employee_name || <span className="text-muted2">—</span> },
    /* 승인번호는 칸을 두지 않는다 — 중복 판정에만 쓰고, 겹치면 '중복 의심 ▾' 비교 표에, 없으면 '값 확인' 경고에 나온다 */
  ],

  dupHelp: (
    <><b>승인번호</b>가 이미 등록된 건은 <b>중복</b>이라 기본은 건너뜁니다 — 같은 명세서를 다시 올려도 두 번 쌓이지 않아요.
    승인번호가 없는 파일은 <b>같은 날 · 같은 금액</b>의 지출이 이미 있으면 <b>확인 필요</b>로만 표시합니다(같은 가게에서
    같은 금액을 두 번 쓰는 일이 있어 자동으로 건너뛰지 않아요).
    할부는 <b>승인일에 전액</b>으로 잡습니다 — 카드사의 '청구 내역'(회차별 청구액)을 올리면 원금이 회차마다 또 잡히니
    <b>이용내역(승인내역)</b>을 올려주세요.</>
  ),
  }
}
