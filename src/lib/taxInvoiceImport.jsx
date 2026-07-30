import { Icon, fmtNum } from './ui'
import { api } from './api'
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

export const taxInvoiceImportAdapter = ({ ourBizNo = '', defaultKind = 'issued' } = {}) => ({
  label: '세금계산서',
  title: '홈택스 세금계산서 업로드',
  sub: '홈택스에서 내려받은 전자세금계산서 목록을 청구서로 한 번에 등록해요. 매출은 미수금, 매입은 미지급금으로 잡히고 부가세 집계에 바로 반영됩니다. 품목 상세를 포함해 받았다면 품목 내역까지 함께 들어갑니다.',
  templateUrl: '/api/invoices/import/template',
  templateName: '세금계산서_업로드_양식.xlsx',
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
    const made = r.createdVendors || []
    if (made.length) {
      const shown = made.slice(0, 3).join(', ')
      notes.push(`거래처 ${made.length}곳이 새로 등록됐어요 (${shown}${made.length > 3 ? ' 외' : ''}) — 기준정보에서 구분·유형을 확인하세요`)
    }
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
    if (r.closedSkipped) {
      notes.push(`마감된 달의 ${r.closedSkipped}건은 등록하지 않았어요 — 이미 신고한 부가세 자료가 바뀌지 않게 막습니다. 필요하면 환경설정에서 마감을 해제하세요`)
    }
    if (r.dupSkipped) {
      notes.push(`승인번호가 이미 등록된 ${r.dupSkipped}건은 건너뛰었어요 — 같은 세금계산서를 두 번 등록하지 않습니다`)
    }
    if (r.linedInvoices && !opts.registerItems) {
      notes.push('품목은 청구서에만 기록됐어요(기준정보 품목은 그대로) — 함께 등록하려면 업로드 화면에서 옵션을 켜세요')
    }
    return { ...r, note: notes.join(' · ') }
  },

  // 우리 회사 사업자번호는 회사정보에서 채워 넣지만, 종사업장 등으로 다를 수 있어 여기서 고칠 수 있게 둔다.
  // registerItems는 기본 꺼짐 — 켜면 기준정보 품목이 늘어나므로 사람이 정하게 둔다.
  initialOpts: { ourBizNo, defaultKind, dueDays: 30, registerItems: false },
  renderOpts: (opts, patch) => (
    <div className="col gap-12">
      <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 190 }}>
          <div className="text-sm fw-600">우리 회사 사업자등록번호</div>
          <div className="text-xs text-muted2">이 번호로 매출·매입을 가릅니다</div>
        </div>
        <input className="input" style={{ width: 160 }} value={opts.ourBizNo || ''}
          placeholder="000-00-00000"
          onChange={e => patch({ ourBizNo: e.target.value })}/>
        {/* 이 값의 출처를 밝힌다 — 그냥 빈 칸이면 "왜 안 채워졌지"를 알 수 없다.
            원래 자리는 환경설정 › 회사 정보이고, 여기 입력은 이번 업로드에만 쓰는 임시값이다. */}
        {!digits(ourBizNo) ? (
          <span className="text-xs" style={{ color: 'var(--warn-ink)' }}>
            <b>환경설정 › 회사 정보</b>에 사업자등록번호가 비어 있어요 — 거기 한 번 넣어두면 다음부터 자동으로 채워집니다
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
    // 품목이 몇 줄로 들어가는지 — 여러 행이 한 계산서로 묶였다는 것도 여기서 보인다
    { header: '품목', width: 92, className: 'text-sm text-muted', render: (d) => (
      d.lines?.length
        ? <span title={d.lines.map(l => `${l.name || '(이름 없음)'} ${fmtNum(l.amount)}원`).join('\n')}>
            {d.lines.length}개{d.lines[0]?.name ? ` · ${d.lines[0].name}` : ''}
          </span>
        : '—'
    ) },
  ],

  dupHelp: (
    <><b>한 파일 안</b>에서 승인번호가 같은 여러 행은 품목이 나뉜 것으로 보고 <b>한 계산서로 묶습니다</b>(중복이 아닙니다).
    이미 등록된 청구서와 승인번호가 같으면 <b>중복</b>이라 기본은 건너뜁니다 — 같은 파일을 다시 올려도 두 번 쌓이지 않아요.
    승인번호가 없던 기존 청구서(정기청구 자동 발행분 등)와 거래처·작성일자·합계금액이 같으면 <b>확인 필요</b>로
    표시하니, 덮어쓰기를 고르면 그 청구서에 승인번호가 채워집니다. 이미 입금·지급된 청구서는 금액을 덮어쓰지 않고
    승인번호만 채워요.</>
  ),
})
