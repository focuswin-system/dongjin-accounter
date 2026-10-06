import { Icon, fmtNum, Combobox } from './ui'
import { api } from './api'
import { ItemSummary, ItemLines } from './components/ItemSummary'
import { normBizNo, normVendorName } from './normalize'
import {
  T, HOMETAX_TARGETS, guessHometaxColumn, mapHometaxRow, hometaxRowWarns, groupHometaxRows,
  isHometaxRowValid, hometaxInvalidLabel, hometaxMatchKey, digits,
} from './hometax'

/* ── 홈택스 전자세금계산서 엑셀 → 청구서 임포트 어댑터 ──────────────
 *
 * 마법사 UI(파일→매핑→중복검토→등록)는 lib/components/ImportWizard.jsx 공용이고,
 * 여기엔 "홈택스 엑셀을 어떻게 읽고 무엇을 중복으로 볼지"만 둔다.
 * 행 해석 규칙 자체는 lib/hometax.js(순수 함수·테스트 대상)에 있다.
 *
 * 세금계산서 발행/수취 = 채권·채무 발생이므로 청구서(invoices)로 넣는다.
 * 실제 입금·지급은 종전대로 청구서 상세의 정산(매칭)에서 처리한다 — 임포트는 돈을 움직이지 않는다.
 */

const KIND_LABEL = { issued: '매출', received: '매입' }

export const taxInvoiceImportAdapter = ({ ourBizNo = '', defaultKind = 'issued', categories = [] } = {}) => ({
  label: '세금계산서',
  title: '세금계산서 엑셀 업로드',
  sub: '세금계산서 여러 장을 양식에 맞춰 한 번에 등록해요. 매출은 미수금, 매입은 미지급금으로 잡히고 부가세 집계에 바로 반영됩니다.',
  templateUrl: '/api/invoices/import/template',
  templateName: '세금계산서_업로드_양식.xlsx',
  /* 1단계 안내 — **양식에 맞춰 올리는 것**이 기본이다(다른 업로드와 같은 말, 2026-10-02 사용자).
     홈택스 목록 엑셀도 받지만 그건 '이것도 된다'로만 적는다 — 실제 홈택스 파일 형식은 아직 실물로 확인하지 못했다.
     ⚠ 필수 표시는 isHometaxRowValid(lib/hometax.js)·서버 양식 REQUIRED 와 같은 말이어야 한다 */
  guide: {
    intro: <>양식의 열 제목 그대로 올리면 <b>열 매핑 없이</b> 바로 검토 단계로 넘어갑니다.<br/>
      홈택스에서 다운로드한 세금계산서 목록도 올릴 수 있어요 — 이 경우 열을 직접 매핑합니다.</>,
    note: <><b>첫 행(열 제목)은 수정하지 마세요.</b> 예시 행은 지우고 쓰세요.<br/>
      품목이 여러 개면 <b>품목마다 한 줄</b>씩 — 둘째 줄부터는 품목 칸만 채우면 같은 계산서로 묶여요.<br/>
      매출/매입은 사업자등록번호를 우리 회사 번호와 비교해 자동으로 가립니다.</>,
    rows: [
      { col: T.date,   req: true, how: '부가세 귀속 기준일 (발급일 아님)', ex: '2026-07-05', num: true },
      { col: `${T.supName} · ${T.buyName}`, req: true, how: '우리 반대편 상호가 거래처가 됨', ex: '(주)한화오션' },
      { col: T.total,  req: true, how: '합계·공급가액·세액 중 둘만 있어도 됨', ex: '11,000,000', num: true },
      { col: T.confirm, how: '중복 방지 · 품목 묶기 기준', ex: '20260705-4100…', num: true },
      { col: '사업자등록번호', how: '매출/매입 판정에 사용', ex: '111-11-11111', num: true },
      { col: T.docKind, how: '"영세"가 있으면 영세율', ex: '일반' },
      { col: '품목명 · 규격 · 수량 · 단가', how: '품목마다 한 줄 (둘째 줄부터 품목 칸만)', ex: '유지보수 · 월 정액' },
      { col: T.category, how: '비우면 업로드 화면에서 선택', ex: '외주가공비' },
    ],
  },
  targets: HOMETAX_TARGETS,
  requiredTarget: T.date,
  requiredHelp: '작성일자가 있어야 어느 분기 부가세인지 정해집니다. 거래처 상호와 금액도 필요해요.',
  guess: guessHometaxColumn,
  parse: (file) => api.parseTaxInvoiceExcel(file),
  // 건수만 보면 모르는 것들을 결과 화면에 남긴다 — 거래처·품목이 새로 생긴 것, 금액을 덮지 않고 지킨 것.
  commit: async (items, opts = {}) => {
    const r = await api.commitTaxInvoiceImport(items, { registerItems: !!opts.registerItems })
    if (!r.ok) return r
    const notes = []
    // 새 거래처·건너뛴 줄은 결과 화면의 거래처 카드·업로드 내역이 줄마다 보여 준다 — 여기엔 그 밖의 일만
    if ((r.createdVendors || []).length) notes.push('새로 등록된 거래처는 기준정보에서 구분·유형을 확인하세요')
    const items2 = r.createdItems || []
    if (items2.length) {
      const shown = items2.slice(0, 3).join(', ')
      notes.push(`품목 ${items2.length}종이 기준정보에 새로 등록됐어요 (${shown}${items2.length > 3 ? ' 외' : ''}) — 단가는 비어 있으니 필요하면 채우세요`)
    }
    if (r.amountKept) {
      notes.push(`이미 입금·지급된 청구서 ${r.amountKept}건은 정산 잔액이 어긋나지 않게 금액·품목을 그대로 두고 승인번호만 채웠어요`)
    }
    if (r.linedInvoices) {
      notes.push(`${r.linedInvoices}건에 품목 내역이 함께 등록됐어요 — 매입 지급결의서가 품목별로 작성됩니다`)
    }
    if (r.closedSkipped) notes.push('마감 월 줄은 이미 신고한 부가세 자료가 바뀌지 않게 막았어요 — 필요하면 환경설정에서 마감을 해제하세요')
    if (r.linedInvoices && !opts.registerItems) {
      notes.push('품목은 청구서에만 기록됐어요(기준정보 품목은 그대로) — 함께 등록하려면 업로드 화면에서 옵션을 켜세요')
    }
    return { ...r, note: notes.join(' · ') }
  },

  // 우리 회사 사업자번호는 회사정보에서 채워 넣지만, 종사업장 등으로 다를 수 있어 여기서 고칠 수 있게 둔다.
  // registerItems는 기본 꺼짐 — 켜면 기준정보 품목이 늘어나므로 사람이 정하게 둔다.
  initialOpts: { ourBizNo, defaultKind, dueDays: 30, registerItems: false, defaultCategory: '' },
  renderOpts: (opts, patch) => (
    <div className="col gap-12">
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">우리 회사 사업자번호</div>
          <div className="text-xs text-muted2">이 번호로 매출·매입을 가릅니다</div>
        </div>
        <input className="input" style={{ width: 160 }} value={opts.ourBizNo || ''}
          placeholder="예: 000-00-00000"
          onChange={e => patch({ ourBizNo: e.target.value })}/>
        {/* 이 값의 출처를 밝힌다 — 그냥 빈 칸이면 "왜 안 채워졌지"를 알 수 없다.
            원래 자리는 환경설정 › 회사 정보이고, 여기 입력은 이번 업로드에만 쓰는 임시값이다. */}
        {!digits(ourBizNo) ? (
          <span className="text-xs" style={{ color: 'var(--warn-ink)' }}>
            <b>환경설정 › 회사 정보</b>에 사업자번호가 없어요
          </span>
        ) : digits(opts.ourBizNo) === digits(ourBizNo) ? (
          <span className="text-xs text-muted2">환경설정 › 회사 정보에서 가져왔어요</span>
        ) : (
          <span className="text-xs" style={{ color: 'var(--brand-ink)' }}>
            회사 정보의 번호({ourBizNo}) 대신 이 번호를 이번 업로드에만 씁니다
          </span>
        )}
        {!digits(opts.ourBizNo) && (
          <span className="badge warn" style={{ fontSize: 11 }}>
            비어 있으면 아래 기본 구분으로 전부 등록돼요
          </span>
        )}
      </div>
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">기본 구분</div>
          <div className="text-xs text-muted2">사업자번호로 판정 못 한 행에만 적용</div>
        </div>
        <div className="row gap-6">
          {['issued', 'received'].map(k => (
            <button key={k} className={`chip ${opts.defaultKind === k ? 'active' : ''}`}
              onClick={() => patch({ defaultKind: k })}>{KIND_LABEL[k]}</button>
          ))}
        </div>
      </div>
      {/* 비목 — 홈택스 엑셀에 없는 칸이다. 매입은 이게 없으면 발행 전표의 비용 계정이 비어
          일계표·분개장에서 차·대변이 안 맞는다. 엑셀에 '비목' 열을 만들어 연결해도 되고,
          여기서 한 번에 정해도 된다(엑셀 값이 있으면 그쪽이 이긴다). */}
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">비목</div>
          <div className="text-xs text-muted2">엑셀에 비목 열이 없을 때 한 번에 적용</div>
        </div>
        <div style={{ width: 240 }}>
          <Combobox value={opts.defaultCategory || ''} onChange={v => patch({ defaultCategory: v })}
            allowAdd={false}
            options={[{ value: '', label: '비워 둠', sub: '나중에 청구서에서 채우기' },
              ...categories
                .filter(c => c.id?.startsWith(opts.defaultKind === 'issued' ? 'INC-' : 'EXP-'))
                .map(c => ({ value: c.name, label: c.name, sub: c.group_name || '' }))]}
            placeholder="비목 선택"/>
        </div>
        {opts.defaultKind !== 'issued' && !String(opts.defaultCategory || '').trim() && (
          <span className="text-xs" style={{ color: 'var(--warn-ink)' }}>
            매입은 비목이 없으면 전표의 비용 계정이 빈 채로 남아요 — 나중에 청구서에서 채워야 합니다
          </span>
        )}
      </div>
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">결제기한</div>
          <div className="text-xs text-muted2">홈택스 엑셀엔 기한이 없어 작성일자 기준으로 계산해요</div>
        </div>
        <div className="row gap-6" style={{ alignItems: 'center' }}>
          <span className="text-sm text-muted">작성일자 +</span>
          <input className="input" style={{ width: 72 }} value={opts.dueDays ?? ''}
            onChange={e => patch({ dueDays: e.target.value.replace(/[^0-9]/g, '') })}/>
          <span className="text-sm text-muted">일</span>
          <span className="text-xs text-muted2">0이면 기한 없이 등록</span>
        </div>
      </div>
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">미등록 품목 등록</div>
          <div className="text-xs text-muted2">품목은 청구서엔 늘 기록됩니다</div>
        </div>
        <button className={`chip ${opts.registerItems ? 'active' : ''}`}
          onClick={() => patch({ registerItems: !opts.registerItems })}>
          {opts.registerItems ? <Icon.Check size={12}/> : null} 기준정보에 함께 등록
        </button>
        <span className="text-xs text-muted2">
          {opts.registerItems
            ? '엑셀에만 있는 품목이 기준정보 품목으로 추가되고, 같은 이름·규격은 기존 품목에 연결돼요'
            : '기준정보 품목은 늘지 않아요 — 청구서에 이름·규격만 남습니다'}
        </span>
      </div>
    </div>
  ),

  // 품목 상세를 포함해 받으면 계산서 1건이 여러 행으로 온다 → 승인번호로 묶어 한 건으로 만든다
  groupRows: groupHometaxRows,
  mapRow: mapHometaxRow,
  isValid: isHometaxRowValid,
  invalidLabel: hometaxInvalidLabel,
  rowWarns: (d, _g, opts) => hometaxRowWarns(d, opts),
  matchKey: (d) => hometaxMatchKey(d, normVendorName),

  // 기존 청구서와의 대조. 승인번호가 유일한 확실한 키이고,
  // 승인번호가 없던 시절 등록분(정기청구 자동 발행 등)은 거래처+작성일자+합계로 후보만 제시한다.
  buildIndex: (existing) => {
    const byConfirm = new Map(), byKey = new Map()
    for (const inv of existing) {
      const c = digits(inv.ntsConfirmNo)
      if (c && !byConfirm.has(c)) byConfirm.set(c, inv)
      const k = `${inv.kind}|${normVendorName(inv.vendor)}|${inv.issuedAt}|${Number(inv.totalAmount)}`
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k).push(inv)
    }
    return { byConfirm, byKey }
  },
  findMatch: (d, idx) => {
    const c = digits(d.nts_confirm_no)
    const matched = c ? (idx.byConfirm.get(c) || null) : null
    if (matched) return { matched, candidates: [] }
    const key = `${d.kind}|${normVendorName(d.vendor_name)}|${d.issued_at}|${Number(d.total_amount)}`
    return { matched: null, candidates: idx.byKey.get(key) || [] }
  },
  // 이미 입금·지급이 붙은 청구서는 덮어써도 금액이 바뀌지 않는다(정산 잔액이 어긋나므로 서버가 막는다).
  // 고르기 전에 알 수 있도록 여기에 적는다.
  candidateLabel: (c) => ({
    label: `${c.invoiceNo} · ${c.vendor || '거래처 없음'}`,
    sub: c.paidAmount > 0
      ? `${fmtNum(c.totalAmount)}원 · 이미 ${fmtNum(c.paidAmount)}원 정산됨 — 승인번호만 채워요`
      : `${fmtNum(c.totalAmount)}원 · ${c.status}`,
  }),

  // 품목이 둘 이상인 계산서만 펼친다 — 하나면 칸에 다 보인다
  vendorOf: (d) => d.vendor_name,
  bizOf: (d) => d.biz_no,
  withVendor: (d, name) => ({ ...d, vendor_name: name }),
  // 등록 불가 줄에서 틀린 칸만 — isHometaxRowValid 와 같은 세 칸
  fixFields: (d) => [
    !d.issued_at && { key: 'issued_at', label: '작성일자', kind: 'date' },
    !d.vendor_name && { key: 'vendor_name', label: '거래처 상호', kind: 'text' },
    !(d.total_amount > 0) && { key: 'total_amount', label: '합계금액 (부가세 포함)', kind: 'money' },
  ].filter(Boolean),
  // 합계를 고치면 공급가액·세액을 과세유형대로 다시 나눈다(과세 10%, 면세·영세 0) — 화면과 서버가 같은 값을 갖게
  applyFix: (d, fix) => {
    const n = { ...d, ...fix }
    if (fix.total_amount != null) {
      const total = Number(fix.total_amount) || 0
      /* 금액 칸이 통째로 비어 있던 줄은 '세액 0 → 면세'로 읽혀 있다. 그건 면세라서가 아니라 값이 없어서다 —
         영세가 아니면 과세로 본다(과세가 압도적으로 많다). 면세 건이면 등록 뒤 청구서에서 고친다 */
      // 종류에 '계산서'(면세)·'면세'라고 적힌 줄은 면세 그대로 — 없는 세액 1/11 을 만들지 않는다(검토)
      const exempt = /면세|^\s*계산서/.test(String(d._docKind || ''))
      if (!(Number(d.supply_amount) > 0) && !(Number(d.vat_amount) > 0) && n.tax_type !== '영세' && !exempt) n.tax_type = '과세'
      const supply = n.tax_type === '과세' ? Math.round(total / 1.1) : total
      Object.assign(n, { total_amount: total, supply_amount: supply, vat_amount: total - supply })
    }
    return n
  },
  compareCols: [
    ['청구번호', c => c.invoiceNo, true], ['작성일자', c => c.issuedAt, true], ['거래처', c => c.vendor || '—'],
    ['합계', c => fmtNum(c.totalAmount), true], ['승인번호', c => c.ntsConfirmNo || '—', true],
    ['상태', c => (c.paidAmount > 0 ? `${c.status} · ${fmtNum(c.paidAmount)}원 정산` : c.status)],
  ],
  rowDetail: (d) => ((d.lines || []).length > 1 ? <ItemLines lines={d.lines}/> : null),
  previewCols: [
    { header: '구분', width: 56, render: (d) => (
      <span className={`badge ${d.kind === 'issued' ? 'brand' : 'outline'}`} style={{ fontSize: 10 }}>
        {KIND_LABEL[d.kind]}
      </span>
    ) },
    { header: '작성일자', width: 96, className: 'num text-sm', render: (d) => d.issued_at || <span className="text-neg">—</span> },
    { header: '거래처', className: 'fw-600', render: (d) => d.vendor_name || <span className="text-neg">—</span> },
    { header: '공급가액', className: 'num text-sm', render: (d) => fmtNum(d.supply_amount) },
    { header: '세액', className: 'num text-sm text-muted', render: (d) => fmtNum(d.vat_amount) },
    { header: '합계', className: 'num text-sm fw-600', render: (d) => fmtNum(d.total_amount) },
    { header: '과세', width: 52, render: (d) => (
      <span className="badge outline" style={{ fontSize: 10 }}>{d.tax_type}</span>
    ) },
    // 품목 — '첫 품목 외 N건'. 줄을 누르면 품목이 아래로 펼쳐진다(rowDetail)
    { header: '품목', maxWidth: 240, className: 'text-sm text-muted',
      render: (d, { open } = {}) => <ItemSummary names={(d.lines || []).map(l => l.name)} open={open}/> },
  ],

  dupHelp: (
    <><b>한 파일 안</b>에서 승인번호가 같은 여러 행은 품목이 나뉜 것으로 보고 <b>한 계산서로 묶습니다</b>(중복이 아닙니다).
    이미 등록된 청구서와 승인번호가 같으면 <b>중복</b>이라 기본은 건너뜁니다 — 같은 파일을 다시 올려도 두 번 쌓이지 않아요.
    승인번호가 없던 기존 청구서(정기청구 자동 발행분 등)와 거래처·작성일자·합계금액이 같으면 <b>확인 필요</b>로
    표시하니, 덮어쓰기를 고르면 그 청구서에 승인번호가 채워집니다. 이미 입금·지급된 청구서는 금액을 덮어쓰지 않고
    승인번호만 채워요.</>
  ),
})
