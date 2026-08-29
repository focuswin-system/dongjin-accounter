import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox, MoneyInput, localToday, Popover, Loading, periodToRange, DateInput } from '../lib/ui'
// SAMPLE placeholder — Docs 화면은 실 API 연동 전까지 빈 데이터로 동작
const SAMPLE = {
  docs: [], evidences: [], evidenceMissing: [], excelPreview: [],
  incomes: [], expenses: [], contractSummary: [],
  receivables: { summary: { total: 0, thisMonth: 0, overdue: 0, longOverdue: 0 }, rows: [] },
}
import { computeItems, shiftMonth, monthLabel } from './HR'
import { api } from '../lib/api'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { PageHeader } from '../lib/components/PageHeader'
import { TileBoard } from '../lib/components/TileBoard'
import { usePerms } from '../lib/perms'
import { downloadVisibleTables } from '../lib/export'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'

const todayStr = () => localToday()   // UTC 금지 — KST 새벽에 하루 전으로 찍힌다

const FormBlock = ({ title, hint, children }) => (
  <div>
    <div className="fw-700" style={{ fontSize: 17, marginBottom: 4, letterSpacing: "-0.02em" }}>{title}</div>
    {hint && <div className="text-sm text-muted" style={{ marginBottom: 14 }}>{hint}</div>}
    {children}
  </div>
);

/* ============ 지출 등록 Drawer (레거시 7-step) ============ */

/* ============ 결의서 관리 ============ */
export const DocsScreen = () => {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [company, setCompany] = useState(null);
  const [selId, setSelId] = useState(null);
  const [q, setQ] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);   // 처리된 결의서까지 볼지

  const load = async () => {
    const [list, comp] = await Promise.all([api.getResolutions(), api.getCompany()]);
    setDocs(list); setCompany(comp);
  };
  useEffect(() => { load(); }, []);

  // 기본은 '처리 안 된 것'만 = 할 일 큐. 완료(처리됨)는 전체 보기에서만.
  const pendingCount = docs.filter(d => d.status !== '완료').length;
  const list = docs
    .filter(d => showDone || d.status !== '완료')
    .filter(d => !q || (d.title || "").includes(q) || (d.vendor_name || "").includes(q) || (d.doc_no || "").includes(q));

  /* 선택은 **지금 목록에 보이는 것** 중에서만 유지한다.
     예전엔 전체 docs 에서 골랐다(`list[0]` 도 필터 전 배열이었다). 그래서
     '전체' 탭에서 완료 결의서를 열어둔 채 '처리 대기'로 돌아오면 왼쪽 목록엔 없는
     완료 문서가 오른쪽에 그대로 떠 있었다 — 탭이 거르는 의미가 사라진다.
     검색어를 쳐서 선택 건이 목록에서 빠질 때도 같은 일이 난다. */
  useEffect(() => {
    setSelId(prev => (prev && list.some(d => d.id === prev)) ? prev : (list[0]?.id || null));
  }, [docs, showDone, q]);   // eslint-disable-line react-hooks/exhaustive-deps
  const sel = list.find(d => d.id === selId) || null;

  return (
    <div className="fade-up">
      <PageHeader
        title="지급결의서"
        actions={<button className="btn primary" onClick={() => setNewOpen(true)}><Icon.Plus/> 새 결의서</button>}
      />

      <NewResolutionDrawer open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); load().then(() => setSelId(id)); }}/>

      <DocWorkspace>
        <DocSide top={<>
          <div className="row gap-6">
            <button className={`chip ${!showDone ? "active" : ""}`} onClick={() => setShowDone(false)}>
              처리 대기 {pendingCount > 0 && <span className="badge brand" style={{ marginLeft: 6 }}>{pendingCount}</span>}
            </button>
            <button className={`chip ${showDone ? "active" : ""}`} onClick={() => setShowDone(true)}>전체</button>
          </div>
          <div className="search" style={{ margin: 0, padding: "6px 10px" }}>
            <Icon.Search size={14}/>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="문서번호·거래처·목적 검색"/>
          </div>
        </>}>
          {list.length === 0
            ? <DocSideEmpty>{showDone ? "결의서가 없어요." : "처리 대기 중인 결의서가 없어요."}<br/>'새 결의서'로 만들거나 매입의 대금 청구서에서 발행하세요.</DocSideEmpty>
            : list.map(d => (
              <DocListRow key={d.id} active={d.id === selId} onClick={() => setSelId(d.id)}
                docNo={d.doc_no} right={<StatusBadge status={d.status}/>}
                title={d.title} meta={`${d.pay_date || "—"} · ${d.vendor_name || "—"}`} amount={d.amount}/>
            ))}
        </DocSide>
        <DocMain>
          {sel
            ? <ResolutionPreview doc={sel} company={company} onSaved={load} onDeleted={() => { setSelId(null); load(); }}/>
            : <DocEmpty icon={<Icon.Receipt size={32} style={{ opacity: 0.3 }}/>}>결의서를 선택하면 내용이 표시됩니다</DocEmpty>}
        </DocMain>
      </DocWorkspace>
    </div>
  );
};

// 새 결의서 직접 등록 — 청구서 없는 소액 경비(비누·간식 등). 지급 전에 결의서부터 작성해 결재받는 흐름.
const NewResolutionDrawer = ({ open, onClose, onCreated }) => {
  const toast = useToast();
  const empty = { vendor: '', title: '', amount: '', pay_method: '계좌이체', pay_date: todayStr(), note: '' };
  const [form, setForm] = useState(empty);
  const [vendors, setVendors] = useState([]);
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState('');   // 선택한 결재선 프리셋
  useEffect(() => {
    if (!open) return;
    setForm(empty);
    api.getVendors().then(setVendors);
    api.getApprovalPresets().then(list => {
      setPresets(list);
      setPresetId((list.find(p => p.is_default) || list[0])?.id || '');   // 기본 프리셋 선택
    });
  }, [open]);

  const amountNum = parseInt(String(form.amount).replace(/[^0-9]/g, ''), 10) || 0;
  const chosen = presets.find(p => p.id === presetId);
  const save = async () => {
    if (!form.title.trim()) return toast.push('지출 목적을 입력해주세요');
    if (!amountNum) return toast.push('금액을 입력해주세요');
    const res = await api.createResolution({
      vendor_name: form.vendor.trim(),
      title: form.title.trim(),
      amount: amountNum,
      pay_method: form.pay_method,
      pay_date: form.pay_date || null,
      note: form.note.trim(),
      approval: chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined,
    });
    if (!res.ok) return toast.push(res.error || '생성에 실패했어요', { tone: 'warn' });
    toast.push(`결의서 ${res.resolution.doc_no}를 만들었어요`);
    onCreated(res.resolution.id);
  };

  return (
    <Drawer open={open} onClose={onClose} width="min(460px,100vw)" label="새 결의서">
      <DrawerHead title="새 지급결의서" onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">청구서(세금계산서) 없는 지출을 결의서로 만들어요. 품목을 여러 줄로 나누려면 만든 뒤 상세에서 편집하세요.</div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>지출처 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <Combobox value={form.vendor} onChange={v => setForm(f => ({ ...f, vendor: v }))}
            options={vendors.map(v => ({ value: v.name, label: v.name, sub: v.type || '' }))}
            placeholder="거래처 선택 또는 새로 추가"
            onAddNew={async (q) => {
              // 지출처는 매입처(A)로 등록 — 이후 다른 화면에서도 선택 가능. 상세 문구는 결의서 상세에서 수정.
              const res = await api.addVendor({ name: q, gubu: 'A' })
              if (res.ok) {
                setVendors(await api.getVendors())
                setForm(f => ({ ...f, vendor: q }))
                toast.push(`"${q}" 거래처가 등록됐어요`)
              } else {
                toast.push(res.error || '거래처 등록에 실패했어요', { tone: 'warn' })
              }
            }}
            addNewLabel="거래처로 추가"/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>지출 목적 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <input className="input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="예: 사무실 간식 구입"/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>금액 (VAT 포함) <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <div style={{ position: 'relative' }}>
            <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
              value={form.amount}
              onChange={raw => setForm(f => ({ ...f, amount: raw }))}/>
            <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>지급 방법</label>
            <div className="row gap-6">
              {['계좌이체', '현금', '카드'].map(m => (
                <button key={m} type="button" className={`chip ${form.pay_method === m ? 'active' : ''}`}
                  onClick={() => setForm(f => ({ ...f, pay_method: m }))}>{m}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>지급일</label>
            <DateInput className="input" value={form.pay_date} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))}/>
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>특기사항 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="예: 팀 공용"/>
        </div>
        {/* 결재선 — 프리셋에서 선택. 기본 프리셋이 미리 골라져 있음. 만든 뒤 상세에서 바꿀 수도 있음. */}
        {presets.length > 0 && (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>결재선</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {presets.map(p => (
                <button key={p.id} type="button" className={`chip ${presetId === p.id ? 'active' : ''}`}
                  onClick={() => setPresetId(p.id)}>{p.name}</button>
              ))}
            </div>
            {chosen && (
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                {chosen.steps.map((s, i) => `${s.label}${s.position ? `(${s.position})` : ''}`).join(' → ')}
              </div>
            )}
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel="결의서 만들기"/>
    </Drawer>
  );
};

// 출금 계좌 선택 — 계좌가 비면 그 지출은 어느 계좌 잔액에서도 빠지지 않으므로 필수 입력이다.
const AccountPick = ({ accounts, value, onChange, hint }) => (
  <div>
    <label className="label" style={{ marginBottom: 8 }}>출금 계좌 <span style={{ color: 'var(--danger, #dc2626)' }}>*</span></label>
    <Combobox
      value={value}
      onChange={onChange}
      options={accounts.map(a => ({
        value: a.id,
        label: a.name,
        sub: [a.kind === 'card' ? '카드' : a.bankName, a.number].filter(Boolean).join(' '),
      }))}
      placeholder="계좌 선택"/>
    <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
      {hint || '이 계좌에서 나간 것으로 기록돼 잔액에 반영됩니다.'}
    </div>
  </div>
);

// 결의서 처리 — 이 결의서대로 지출을 집행한다.
//   기존 지출 연결: 이미 카드·이체로 나간 지출을 이 결의서에 붙임
//   새 지출 등록: 결의서 내용으로 지출 거래를 생성(금액 자동, 수정 가능)
// 어느 쪽이든 그 지출의 증빙(doc_no)에 결의서번호가 붙어 추적된다.
const ProcessDrawer = ({ open, onClose, doc, onDone }) => {
  const toast = useToast();
  const [mode, setMode] = useState('create');   // 'create' | 'link'
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayStr());
  const [candidates, setCandidates] = useState([]);
  const [pickedTxn, setPickedTxn] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('create'); setAmount(String(doc.amount || ''));
    /* 지출일 기본값은 **오늘까지**로 자른다.
     * doc.pay_date 는 '언제까지 주기로 한 날'(지급 기한)이라 대개 미래다. 그걸 그대로
     * 채워 두면 사용자가 아무것도 안 바꾸고 '처리 완료'를 눌렀을 때
     * 서버가 "미래 날짜로는 처리할 수 없어요"로 거절한다 — 화면이 스스로 만든 기본값이
     * 자기 규칙에 걸리는 셈이라, 뭘 고쳐야 하는지도 알기 어렵다.
     * 결의서 처리의 지출일은 '실제로 돈이 나간 날'이므로 미래일 수 없다. */
    const t = todayStr();
    setDate(doc.pay_date && doc.pay_date <= t ? doc.pay_date : t);
    setPickedTxn(null);
    api.getResolutionMatchable(doc.id).then(setCandidates);
    api.getAccounts().then(list => {
      setAccounts(list);
      // 은행계좌를 기본 선택(kind='bank' — type은 '보통예금'/'법인카드' 값이라 쓰면 안 된다).
      // 카드 지출도 있으므로 목록에서는 카드도 고를 수 있게 둔다.
      const bank = list.find(a => a.kind === 'bank') || list[0];
      setAccountId(prev => prev || bank?.id || '');
    });
  }, [open, doc.id]);

  const amountNum = parseInt(String(amount).replace(/[^0-9]/g, ''), 10) || 0;
  // 연결 대상이 이미 계좌를 갖고 있으면 그 계좌가 쓰인다(서버 우선순위). 없을 때만 골라야 한다.
  const pickedRow = candidates.find(t => t.id === pickedTxn);
  const linkNeedsAccount = mode === 'link' && pickedRow && !pickedRow.account_id;
  const needsAccount = mode === 'create' || linkNeedsAccount;

  const submit = async () => {
    if (mode === 'link' && !pickedTxn) return toast.push('연결할 지출을 선택해주세요');
    if (needsAccount && !accountId) return toast.push('출금 계좌를 선택해주세요');
    const body = mode === 'link'
      ? { mode: 'link', txn_id: pickedTxn, account_id: accountId || null }
      : { mode: 'create', amount: amountNum, date, account_id: accountId || null };
    const res = await api.processResolution(doc.id, body);
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' });
    const base = mode === 'link' ? '기존 지출에 연결했어요' : '지출을 등록하고 처리했어요';
    toast.push(res.invoicePaid ? `${base}. 청구서도 지급 처리됐어요` : base);
    onDone();
  };

  return (
    <Drawer open={open} onClose={onClose} width="min(480px,100vw)" label="결의서 처리">
      <DrawerHead title="결의서 처리" sub={<>{doc.doc_no} · {doc.title} · {fmtNum(doc.amount)}원</>} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">이 결의서대로 지출을 집행합니다. 처리하면 목록의 '처리 대기'에서 빠져요.</div>
        <div className="row gap-6">
          <button type="button" className={`chip ${mode === 'create' ? 'active' : ''}`} onClick={() => setMode('create')}>지출 새로 등록</button>
          <button type="button" className={`chip ${mode === 'link' ? 'active' : ''}`} onClick={() => setMode('link')}>기존 지출에 연결</button>
        </div>

        {mode === 'create' ? (
          <>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>지출 금액</label>
              <div style={{ position: 'relative' }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={amount}
                  onChange={raw => setAmount(raw)}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>결의서 금액으로 채웠어요. 실제 지출액이 다르면 고치세요.</div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>지출일</label>
              <DateInput className="input" max={localToday()} value={date} onChange={e => setDate(e.target.value)}/>
            </div>
            <AccountPick accounts={accounts} value={accountId} onChange={setAccountId}/>
            <div className="text-xs text-muted2">{doc.vendor_name || '거래처 미지정'} · {doc.pay_method || '계좌이체'}로 지출 거래가 생성됩니다.</div>
          </>
        ) : (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>연결할 지출 거래</label>
            {candidates.length === 0 ? (
              <div className="text-sm text-muted2" style={{ padding: 16, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8 }}>
                연결할 미연결 지출이 없어요. '지출 새로 등록'을 쓰세요.
              </div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {candidates.map(t => (
                  <button key={t.id} type="button" onClick={() => setPickedTxn(t.id)}
                    style={{ textAlign: 'left', padding: '10px 12px', border: `1px solid ${pickedTxn === t.id ? 'var(--brand)' : 'var(--line)'}`,
                             borderRadius: 8, background: pickedTxn === t.id ? 'var(--brand-soft)' : '#fff', cursor: 'pointer' }}>
                    <div className="row gap-8">
                      <span className="fw-600 text-sm">{t.vendor_name || '거래처 미상'}</span>
                      {t.related && <span className="badge outline" style={{ fontSize: 10 }}>같은 거래처</span>}
                      <span className="ml-auto num fw-700">{fmtNum(t.amount)}원</span>
                    </div>
                    <div className="text-xs text-muted2" style={{ marginTop: 3 }}>
                      {t.date} · {t.category || '—'} · {t.status}
                      {!t.account_id && <span style={{ color: 'var(--warn, #b45309)' }}> · 계좌 없음</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {pickedRow && pickedRow.status !== '지급완료' && (
              <div className="text-xs" style={{ marginTop: 8, color: 'var(--muted-2)' }}>
                이 거래는 아직 <b>{pickedRow.status}</b> 상태예요. 연결하면 <b>지급완료</b>로 함께 처리돼 계좌 잔액에서 빠집니다.
              </div>
            )}
            {linkNeedsAccount && (
              <div style={{ marginTop: 10 }}>
                <AccountPick accounts={accounts} value={accountId} onChange={setAccountId}
                  hint="이 거래에는 출금 계좌가 없어요. 지정해야 잔액에 반영됩니다."/>
              </div>
            )}
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={submit} saveLabel="처리 완료"/>
    </Drawer>
  );
};

// 읽기전용 결의서 문서 — 결의서 화면과 지출 증빙 영역 양쪽에서 재사용.
// printClass가 있으면 그 요소가 인쇄 대상이 된다(증빙 모달에서 이것만 뽑아 인쇄).
export const ResolutionDocument = ({ doc, company, printClass }) => {
  const items = doc.items && doc.items.length ? doc.items
    : [{ name: doc.title, unit: '식', qty: 1, price: doc.amount, amount: doc.amount, note: '' }];
  const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const ceo = company?.ceo || '대표이사';
  // 결재선: 결의서에 저장된 approval, 없으면 담당/결재/대표 기본
  const approval = (doc.approval && doc.approval.length)
    ? doc.approval
    : [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: ceo }];
  return (
    <div className={`doc-paper resolution-paper ${printClass || ''}`}>
      <div className="res-title-ko">지출결의서</div>
      <div className="res-title">支 出 決 議 書</div>
      <div className="res-date num">{doc.pay_date || ''}</div>

      <table className="res-table res-head">
        <tbody>
          <tr><th>지출처</th><td>{doc.vendor_name}</td><th>지출총액</th><td className="num fw-700">₩ {fmtNum(total || doc.amount)}</td></tr>
          <tr><th>구매품의NO</th><td className="num">{doc.doc_no}</td><th>신청자</th><td>{doc.applicant}</td></tr>
          <tr><th>지출방법</th><td>{doc.pay_method}</td><th>지급일</th><td className="num">{doc.pay_date || '—'}</td></tr>
        </tbody>
      </table>

      <div className="res-note-line">아래 내역과 같이 支出코저 하오니 承認하여 주시기 바랍니다.</div>

      <table className="res-table res-items">
        <thead>
          <tr>
            <th style={{ width: 34 }}>NO</th><th>품명 및 규격</th><th style={{ width: 50 }}>단위</th>
            <th style={{ width: 56 }}>수량</th><th style={{ width: 96 }}>단가</th><th style={{ width: 110 }}>금액</th><th style={{ width: 90 }}>비고</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="num" style={{ textAlign: 'center' }}>{i + 1}</td>
              <td>{it.name}</td>
              <td style={{ textAlign: 'center' }}>{it.unit}</td>
              <td className="num" style={{ textAlign: 'right' }}>{fmtNum(it.qty || 0)}</td>
              <td className="num" style={{ textAlign: 'right' }}>{fmtNum(it.price || 0)}</td>
              <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(it.amount || 0)}</td>
              <td>{it.note}</td>
            </tr>
          ))}
          {Array.from({ length: Math.max(0, 4 - items.length) }).map((_, i) => (
            <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
          ))}
          <tr className="res-total">
            <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
            <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(total)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div className="res-foot">
        <div className="res-note">
          <div className="res-note-head">특기사항</div>
          <div className="res-note-body">{doc.note || ''}</div>
        </div>
        <table className="res-approve">
          <tbody>
            <tr>{approval.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
            <tr>{approval.map((_, i) => <td key={i}></td>)}</tr>
          </tbody>
        </table>
      </div>

      <div className="res-company">
        {company?.name || ''}{company?.biz_no ? ` · 사업자 ${company.biz_no}` : ''}
      </div>
    </div>
  );
};

// 실제 동진테크 지출결의서 양식(지출처·지출총액·구매품의NO·신청자·지출방법 + 품목 명세 + 결재란) 기반.
// 화면에서 품목·특기사항을 보완하고 인쇄하면 대표가 서명하는 방식(전자결재 아님).
export const ResolutionPreview = ({ doc, company, onSaved, onDeleted }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(doc);
  const [processOpen, setProcessOpen] = useState(false);
  const [presets, setPresets] = useState([]);
  const [itemMaster, setItemMaster] = useState([]);   // 품목 기준정보 — 품명·규격·단위·매입단가 자동채움
  useEffect(() => { setForm(doc); setEdit(false); }, [doc.id]);
  useEffect(() => { api.getApprovalPresets().then(setPresets); }, []);
  useEffect(() => { api.getRefItems('item').then(list => setItemMaster(list || [])); }, []);
  const done = doc.status === '완료';
  // 결재선: 편집 중이면 form, 아니면 doc. 없으면 담당/결재/대표 기본
  const approval = (form.approval && form.approval.length)
    ? form.approval
    : [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: company?.ceo || '대표이사' }];
  const applyPreset = (p) => setForm(f => ({ ...f, approval: p.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) }));

  const items = form.items || [];
  const itemsTotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const setItem = (i, key, val) => setForm(f => ({ ...f, items: (f.items || []).map((it, j) => j === i ? { ...it, [key]: val } : it) }));
  const setItemNum = (i, key, val) => {
    const n = parseInt(String(val).replace(/[^0-9]/g, ''), 10) || 0;
    setForm(f => ({ ...f, items: (f.items || []).map((it, j) => {
      if (j !== i) return it;
      const next = { ...it, [key]: n };
      if (key === 'qty' || key === 'price') next.amount = (Number(next.qty) || 0) * (Number(next.price) || 0);
      return next;
    }) }));
  };
  const addItem = () => setForm(f => ({ ...f, items: [...(f.items || []), { name: '', unit: '식', qty: 1, price: 0, amount: 0, note: '' }] }));
  const removeItem = (i) => setForm(f => ({ ...f, items: (f.items || []).filter((_, j) => j !== i) }));

  /* 기준정보 품목에서 고르면 품명(＋규격)·단위·매입단가를 채운다.
     id 로 찾는다 — 이름이 같고 규격만 다른 품목(도면 개정 등)이면 이름 매칭은 늘 첫 번째를
     집어 다른 개정판의 단위·단가가 들어간다(구매품의서·견적요청서와 같은 이유). */
  const pickItem = (i, val) => setForm(f => {
    const items = [...(f.items || [])];
    const base = items[i] || { name: '', unit: '식', qty: 1, price: 0, amount: 0, note: '' };
    const m = itemMaster.find(x => String(x.id) === String(val));
    // 목록에 없으면 친 그대로 둔다 — 소액 경비는 기준정보에 없는 게 보통이다
    if (!m) { items[i] = { ...base, name: val }; return { ...f, items }; }
    const price = Number(m.purchase_price) || Number(base.price) || 0;
    const qty = Number(base.qty) || 1;
    items[i] = { ...base,
      name: m.spec ? `${m.name} ${m.spec}` : m.name,
      unit: m.unit || base.unit, price, amount: qty * price };
    return { ...f, items };
  });

  /* 연결된 청구서의 품목을 다시 가져온다. 만들 때 한 번 복사하고 끝이라, 청구서에 품목을
     나중에 채워도 결의서는 "매입 대금 지급 · 식 · 1" 그대로 남아 있었다. */
  const reloadLines = async () => {
    const ok = await confirm({
      title: '청구서 품목을 다시 불러올까요?',
      body: '지금 결의서에 적힌 품목은 청구서 내용으로 바뀝니다. 손으로 고친 줄이 있으면 함께 사라져요.',
      confirmLabel: '불러오기',
    });
    if (!ok) return;
    const res = await api.reloadResolutionLines(doc.id);
    if (!res.ok) return toast.push(res.error || '불러오지 못했어요', { tone: 'warn' });
    /* 서버가 돌려준 결의서로 **직접** 갈아끼운다.
       onSaved() 는 목록만 다시 받아오는데, 이 화면의 form 은 `doc.id` 가 바뀔 때만
       다시 맞춰진다(편집 중 부모가 리렌더될 때마다 입력이 날아가지 않게 하려고 그렇다).
       같은 문서의 내용만 바뀐 지금은 id 가 그대로라 form 이 옛 품목·옛 금액에 머물렀다 —
       왼쪽 목록은 550,000인데 본문 지출총액은 500,000으로 남는 식이다. */
    setForm(res.resolution);
    toast.push(`${res.resolution.invoiceNo || '청구서'} 품목 ${res.resolution.lineCount}줄을 불러왔어요`);
    setEdit(false); onSaved();
  };

  const save = async () => {
    const res = await api.updateResolution(doc.id, { ...form, amount: itemsTotal || form.amount });
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' });
    toast.push('결의서를 저장했어요'); setEdit(false); onSaved();
  };
  const remove = async () => {
    /* 완료된 결의서는 지출 거래·청구서 정산을 물고 있다. 그냥 지우면 그것들이 고아로 남고
       되돌릴 손잡이(결의서)만 사라진다 — 잘못 지급한 건을 영영 못 되돌린다.
       그래서 완료 건은 "지출까지 함께 지운다"고 분명히 말하고 cascade 로 부른다. */
    const ok = await confirm({
      tone: 'neg',
      title: done ? '결의서·지출 함께 삭제' : '결의서 삭제',
      body: done
        ? <>
            <div style={{ marginBottom: 6 }}>{doc.doc_no} 결의서와 <b>이 결의서로 집행된 지출 이력</b>을 함께 지웁니다.</div>
            <div>연결된 매입 청구서가 있으면 <b>미지급</b>으로 되돌아가고, 계좌 잔액도 그만큼 복구됩니다.</div>
            <div style={{ marginTop: 6 }} className="text-muted">
              이미 있던 거래에 연결만 한 경우, 그 거래는 실제로 오간 돈이라 지우지 않고 연결만 끊어요.
            </div>
          </>
        : `${doc.doc_no} 결의서를 삭제할까요? 거래는 그대로 남아요.`,
      confirmLabel: '삭제',
    });
    if (!ok) return;
    const res = await api.deleteResolution(doc.id, { cascade: done });
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요', { tone: 'warn' });
    toast.push(res.keptTxn
      ? '삭제됐어요. 연결돼 있던 지출 거래는 장부에 남겨뒀어요(연결 전 상태로 되돌렸습니다).'
      : '삭제됐어요');
    onDeleted();
  };

  /* 처리 취소 — 잘못 집행한 건을 '처리 대기'로 되돌린다.
     청구서 쪽 정산 취소가 "결의서에서 되돌려주세요"라고 안내하는 그 출구다. */
  const unprocess = async () => {
    const ok = await confirm({
      tone: 'neg',
      title: '처리를 취소할까요?',
      body: <>
        <div style={{ marginBottom: 6 }}>{doc.doc_no} 집행을 되돌려 <b>처리 대기</b>로 보냅니다.</div>
        <div>이 결의서로 만든 지출 거래는 지워지고, 연결된 매입 청구서는 <b>미지급</b>으로 되돌아갑니다.</div>
        <div style={{ marginTop: 6 }} className="text-muted">마감된 달의 지출은 되돌릴 수 없어요(그 달 잔액이 바뀝니다).</div>
      </>,
      confirmLabel: '처리 취소',
    });
    if (!ok) return;
    const res = await api.unprocessResolution(doc.id);
    if (!res.ok) return toast.push(res.error || '되돌리지 못했어요', { tone: 'warn' });
    /* 무엇을 했는지 그대로 말한다. '남겨뒀다'만 말하면, 그 거래가 여전히 '지급완료'인지
       원래 상태로 돌아갔는지 알 수 없어 사용자가 장부를 직접 확인해야 한다. */
    toast.push(!res.keptTxn ? '처리를 취소했어요. 처리 대기로 돌아갔어요.'
      : res.restored ? '처리를 취소했어요. 연결돼 있던 지출 거래는 연결 전 상태로 되돌렸어요.'
      : '처리를 취소했어요. 연결돼 있던 지출 거래는 장부에 그대로 남아 있어요 — 상태를 확인해주세요.');
    onSaved();
  };
  const doPrint = () => window.print();

  const ceo = company?.ceo || '대표이사';
  const displayItems = edit ? items : (items.length ? items : [{ name: form.title, unit: '식', qty: 1, price: form.amount, amount: form.amount, note: '' }]);

  return (
    <>
      {/* 콘텐츠 헤더(공용) — 문서번호·상태 + 액션(편집·인쇄·처리·삭제) */}
      <DocToolbar docNo={doc.doc_no} status={<StatusBadge status={doc.status}/>}>
        {edit ? (
          <>
            {/* 청구서에서 만든 결의서만. 직접 만든 것은 가져올 데가 없다. */}
            {doc.invoice_id && (
              <button className="btn" onClick={reloadLines} title="연결된 청구서의 품목 내역을 그대로 가져옵니다">
                <Icon.Refresh size={14}/> 청구서 품목 불러오기
              </button>
            )}
            <button className="btn" onClick={() => { setForm(doc); setEdit(false); }}>취소</button>
            <button className="btn primary" onClick={save}><Icon.Check size={14}/> 저장</button>
          </>
        ) : (
          <>
            {/* 삭제는 완료 건에도 있다. 잘못 집행한 결의서를 없앨 길이 없으면
                틀린 지출이 장부에 영원히 남는다(완료 건은 지출까지 함께 되돌린다). */}
            <button className="btn ghost" onClick={remove} title={done ? '결의서와 지출 이력을 함께 삭제' : '결의서 삭제'}>
              <Icon.Trash size={14}/>
            </button>
            {!done && <button className="btn" onClick={() => setEdit(true)}><Icon.Pencil size={14}/> 편집</button>}
            <button className="btn" onClick={doPrint}><Icon.Print/> 인쇄</button>
            {/* 처리 = 이 결의서대로 지출 집행. 처리되면 목록에서 빠진다. */}
            {done
              ? <>
                  <span className="badge pos" style={{ alignSelf: 'center' }}><span className="dot"/>처리 완료</span>
                  <button className="btn" onClick={unprocess} title="집행을 되돌려 처리 대기로 보냅니다">
                    <Icon.Refresh size={14}/> 처리 취소
                  </button>
                </>
              : <button className="btn primary" onClick={() => setProcessOpen(true)}><Icon.Check size={14}/> 처리</button>}
          </>
        )}
      </DocToolbar>

      <ProcessDrawer open={processOpen} onClose={() => setProcessOpen(false)} doc={doc}
        onDone={() => { setProcessOpen(false); onSaved(); }}/>

      {/* 인쇄 대상 — 실제 결의서 양식(가로 계열이라 그대로 폭 채움) */}
      <DocViewport>
      <div className="doc-paper resolution-paper" id="resolution-print">
        <div className="res-title-ko">지출결의서</div>
        <div className="res-title">支 出 決 議 書</div>
        <div className="res-date num">{form.pay_date || ''}</div>

        {/* 헤더 표: 지출처 / 지출총액 / 구매품의NO / 신청자 / 지출방법 */}
        <table className="res-table res-head">
          <tbody>
            <tr>
              <th>지출처</th>
              <td>{edit ? <input className="cell-input" value={form.vendor_name || ''} onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value }))}/> : form.vendor_name}</td>
              <th>지출총액</th>
              <td className="num fw-700">₩ {fmtNum(itemsTotal || form.amount)}</td>
            </tr>
            <tr>
              <th>구매품의NO</th>
              <td className="num">{form.doc_no}</td>
              <th>신청자</th>
              <td>{edit ? <input className="cell-input" value={form.applicant || ''} onChange={e => setForm(f => ({ ...f, applicant: e.target.value }))}/> : form.applicant}</td>
            </tr>
            <tr>
              <th>지출방법</th>
              <td>{edit ? <input className="cell-input" value={form.pay_method || ''} onChange={e => setForm(f => ({ ...f, pay_method: e.target.value }))}/> : form.pay_method}</td>
              <th>지급일</th>
              <td className="num">{edit ? <DateInput className="cell-input" value={form.pay_date || ''} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))}/> : (form.pay_date || '—')}</td>
            </tr>
          </tbody>
        </table>

        <div className="res-note-line">아래 내역과 같이 支出코저 하오니 承認하여 주시기 바랍니다.</div>

        {/* 품목 명세 */}
        <table className="res-table res-items">
          <thead>
            <tr>
              <th style={{ width: 34 }}>NO</th><th>품명 및 규격</th><th style={{ width: 50 }}>단위</th>
              <th style={{ width: 56 }}>수량</th><th style={{ width: 96 }}>단가</th><th style={{ width: 110 }}>금액</th><th style={{ width: 90 }}>비고</th>
              {edit && <th className="no-print" style={{ width: 32 }}></th>}
            </tr>
          </thead>
          <tbody>
            {displayItems.map((it, i) => (
              <tr key={i}>
                <td className="num" style={{ textAlign: 'center' }}>{i + 1}</td>
                {/* 품명 및 규격 — 기준정보에서 고르면 '품명 규격'으로 채우고 단위·매입단가까지 따라온다.
                    양식의 칸이 하나라 합쳐 넣는다(구매품의서·견적요청서와 같은 방식).
                    목록에 없으면 그냥 쳐도 된다 — 소액 경비는 기준정보에 없는 게 보통이다. */}
                {/* value 는 **저장될 이름**이다. item_id 를 주면 Combobox 가 그 id 의 라벨
                    (규격 없는 기준정보 이름)을 그려서, 화면엔 "웹사이트 유지보수"인데
                    인쇄물엔 "웹사이트 유지보수 월정액"이 찍힌다 — 보는 것과 나가는 것이 달라진다.
                    id 가 필요한 건 고를 때뿐이고, 그건 옵션의 value 가 들고 있다. */}
                <td>{edit
                  ? <Combobox value={it.name || ''} onChange={v => pickItem(i, v)}
                      options={itemMaster.map(m => ({ value: m.id, label: m.name,
                        sub: [m.spec, m.unit, m.purchase_price ? `${fmtNum(m.purchase_price)}원` : null].filter(Boolean).join(' · ') }))}
                      placeholder="품목 선택 또는 직접 입력"
                      onAddNew={q => setItem(i, 'name', q)} addNewLabel="직접 입력"/>
                  : it.name}</td>
                <td style={{ textAlign: 'center' }}>{edit ? <input className="cell-input" value={it.unit || ''} onChange={e => setItem(i, 'unit', e.target.value)}/> : it.unit}</td>
                <td className="num" style={{ textAlign: 'right' }}>{edit ? <input className="cell-input num" style={{ textAlign: 'right' }} value={it.qty ?? ''} onChange={e => setItemNum(i, 'qty', e.target.value)}/> : fmtNum(it.qty || 0)}</td>
                <td className="num" style={{ textAlign: 'right' }}>{edit ? <MoneyInput className="cell-input num" style={{ textAlign: 'right' }} placeholder="" value={it.price || ''} onChange={raw => setItemNum(i, 'price', raw)}/> : fmtNum(it.price || 0)}</td>
                <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(it.amount || 0)}</td>
                <td>{edit ? <input className="cell-input" value={it.note || ''} onChange={e => setItem(i, 'note', e.target.value)}/> : it.note}</td>
                {edit && <td className="no-print" style={{ textAlign: 'center' }}><button className="icon-btn" onClick={() => removeItem(i)}><Icon.Close size={13}/></button></td>}
              </tr>
            ))}
            {/* 빈 줄 채우기(양식 느낌) — 화면 편집 중엔 생략 */}
            {!edit && Array.from({ length: Math.max(0, 4 - displayItems.length) }).map((_, i) => (
              <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
            ))}
            <tr className="res-total">
              <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
              <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(edit ? itemsTotal : (displayItems.reduce((s, it) => s + (Number(it.amount) || 0), 0)))}</td>
              <td></td>{edit && <td className="no-print"></td>}
            </tr>
          </tbody>
        </table>
        {edit && <button className="btn sm no-print" style={{ marginTop: 8 }} onClick={addItem}><Icon.Plus size={12}/> 품목 추가</button>}

        {/* 특기사항 + 결재란 */}
        <div className="res-foot">
          <div className="res-note">
            <div className="res-note-head">특기사항</div>
            {edit
              ? <textarea className="cell-input" style={{ width: '100%', minHeight: 60, resize: 'vertical' }} value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}/>
              : <div className="res-note-body">{form.note || ''}</div>}
          </div>
          <div>
            {/* 편집 중이면 프리셋으로 결재선 교체. 결재란은 approval 단계대로 렌더. */}
            {edit && presets.length > 0 && (
              <div className="row gap-6 no-print" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                <span className="text-xs text-muted2" style={{ alignSelf: 'center' }}>결재선</span>
                {presets.map(p => (
                  <button key={p.id} className="btn ghost sm" onClick={() => applyPreset(p)}>{p.name}</button>
                ))}
              </div>
            )}
            <table className="res-approve">
              <tbody>
                <tr>{approval.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
                <tr>{approval.map((_, i) => <td key={i}></td>)}</tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="res-company">
          {company?.name || ''}{company?.biz_no ? ` · 사업자 ${company.biz_no}` : ''}
        </div>
      </div>
      </DocViewport>
    </>
  );
};

// 이전 DocPreview 이름 호환(다른 곳에서 참조 시)
export const DocPreview = ResolutionPreview;

export const Stamp = ({ name, tone = "neg" }) => {
  const color = tone === "neg" ? "var(--neg)" : "var(--ink)";
  return (
    <div style={{
      width: 48, height: 48, borderRadius: "50%", border: `2px solid ${color}`, color,
      fontFamily: '"Noto Serif KR", serif', fontWeight: 700,
      fontSize: name.length >= 3 ? 11 : 13,
      letterSpacing: name.length >= 3 ? "-0.04em" : "-0.02em",
      display: "grid", placeItems: "center", margin: "auto",
      transform: "rotate(-8deg)", lineHeight: 1,
      background: "rgba(255,255,255,0.6)",
      boxShadow: `inset 0 0 0 2px rgba(255,255,255,0.4)`,
      writingMode: name.length >= 3 ? "vertical-rl" : "horizontal-tb",
    }}>
      {name.length === 3 ? <span style={{ writingMode: "vertical-rl", letterSpacing: "0.1em" }}>{name}</span> : name}
    </div>
  );
};

/* ============ 증빙 관리 ============ */
export const EvidenceScreen = ({ onAttach }) => {
  const toast = useToast();
  const [tab, setTab] = useState("전체");
  const [type, setType] = useState("전체");
  const tabs = ["전체", "연결 완료", "연결 필요", "검토 필요", "누락"];
  const types = ["전체", "세금계산서", "영수증", "카드영수증", "통장내역"];

  const rows = SAMPLE.evidences
    .filter(r => tab === "전체" || r.status === tab)
    .filter(r => type === "전체" || r.type === type);

  return (
    <div className="fade-up">
      <PageHeader
        title="증빙 관리"
        actions={<>
          <button className="btn" onClick={() => toast.push("증빙 파일을 ZIP으로 내려받았어요")}><Icon.Download/> 일괄 내려받기</button>
          <button className="btn primary" onClick={() => toast.push("파일 선택 창을 열었어요")}><Icon.Upload/> 파일 업로드</button>
        </>}
      />

      <div className="grid" style={{ gridTemplateColumns: "1fr clamp(240px, 280px, 320px)", gap: 16, alignItems: "start" }}>
        <div>
          <div className="card card-pad" style={{ padding: 14, marginBottom: 16 }}>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {tabs.map(t => (
                <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
              ))}
              <div style={{ width: 1, height: 22, background: "var(--line)", margin: "0 6px" }}/>
              {types.map(t => (
                <button key={t} className={`chip ${type === t ? "active" : ""}`} onClick={() => setType(t)}>{t}</button>
              ))}
            </div>
          </div>
          <div className="drop" style={{ marginBottom: 16 }}>
            <Icon.Upload size={22}/>
            <div className="fw-600" style={{ marginTop: 8 }}>파일을 끌어다 놓아서 한 번에 업로드</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>여러 개를 한 번에 올리면 자동으로 거래내역과 매칭해드려요.</div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {rows.map((r, i) => {
              const isPdf = r.name.endsWith(".pdf");
              const isImg = r.name.endsWith(".jpg") || r.name.endsWith(".png");
              return (
                <div key={i} className="card" style={{ padding: 14, display: "flex", gap: 14, alignItems: "center" }}>
                  <div style={{ width: 52, height: 64, borderRadius: 8, background: "var(--surface-3)", border: "1px solid var(--line)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                    {isPdf ? <Icon.File size={22}/> : isImg ? <Icon.Image size={22}/> : <Icon.Doc size={22}/>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row gap-6" style={{ marginBottom: 4 }}>
                      <span className="badge outline">{r.type}</span>
                      <StatusBadge status={r.status}/>
                    </div>
                    <div className="fw-600" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                    <div className="text-xs text-muted2">{r.size} · {r.date}</div>
                    <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                      {r.linked === "—"
                        ? <span className="text-warn"><Icon.Link size={11}/> 연결할 거래내역을 선택해주세요</span>
                        : <><Icon.Link size={11}/> {r.linked} · {r.contract}</>}
                    </div>
                  </div>
                  <button className="btn ghost sm"><Icon.More/></button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card card-pad" style={{ position: "sticky", top: 88 }}>
          <div className="row" style={{ marginBottom: 12 }}>
            <div>
              <div className="section-title">증빙 누락</div>
              <div className="section-sub">아직 영수증이 없는 지출이에요.</div>
            </div>
            <span className="badge neg ml-auto">{SAMPLE.evidenceMissing.length}건</span>
          </div>
          <div className="col">
            {SAMPLE.evidenceMissing.map((m, i) => (
              <button key={i} onClick={() => onAttach && onAttach(m)}
                className="row gap-10"
                style={{ padding: "12px 0", borderTop: i ? "1px solid var(--line)" : 0, background: "transparent", border: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit", width: "100%" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fw-600 text-sm">{m.title}</div>
                  <div className="text-xs text-muted2">{m.date} · {m.id}</div>
                </div>
                <div className="num fw-700 text-sm">{fmtNum(m.amount)}</div>
                <Icon.Right size={12} className="text-muted2"/>
              </button>
            ))}
          </div>
          <button className="btn" style={{ width: "100%", marginTop: 12 }} onClick={() => toast.push("담당자에게 알림을 보냈어요")}>모두 알림 보내기</button>
        </div>
      </div>
    </div>
  );
};

/* ============ 증빙 첨부 Drawer ============ */
export const EvidenceAttachDrawer = ({ item, onClose }) => {
  const toast = useToast();
  if (!item) return null;
  return (
    <Drawer open={true} onClose={onClose} width="min(480px, 100vw)" label="증빙 첨부">
        <DrawerHead title="증빙 첨부" sub="아래 지출에 증빙 파일을 연결하세요." onClose={onClose}/>
        <div className="drawer-body">
          <div className="card" style={{ padding: 16, background: "var(--surface-2)", border: "1px solid var(--line)", marginBottom: 20 }}>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 4 }}>대상 지출</div>
            <div className="row gap-8">
              <div style={{ flex: 1 }}>
                <div className="fw-700">{item.title}</div>
                <div className="text-xs text-muted">{item.date} · {item.id}</div>
              </div>
              <div className="num fw-700">{fmtNum(item.amount)}원</div>
            </div>
          </div>
          <div className="drop">
            <Icon.Upload size={22}/>
            <div className="fw-600" style={{ marginTop: 8 }}>증빙 파일을 끌어다 놓거나 클릭해서 업로드</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>PDF, JPG, PNG · 최대 20MB</div>
          </div>
          <div style={{ marginTop: 18 }}>
            <label className="label">증빙 유형</label>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {["세금계산서", "영수증", "카드영수증", "통장내역", "기타"].map((t, i) => (
                <button key={t} className={`chip ${i === 1 ? "active" : ""}`}>{t}</button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 20 }}>
            <label className="label">최근 업로드된 파일에서 선택</label>
            <div className="col gap-8">
              {[
                { name: "이마트_영수증_0510.jpg", type: "영수증", size: "612KB" },
                { name: "택시영수증_0506.jpg", type: "영수증", size: "302KB" },
                { name: "법인카드_0511_명세.csv", type: "카드영수증", size: "12KB" },
              ].map(f => (
                <button key={f.name} className="row gap-10"
                  style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, background: "#fff", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
                  <Icon.Image size={16}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="text-sm fw-600" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                    <div className="text-xs text-muted2">{f.type} · {f.size}</div>
                  </div>
                  <span className="badge outline">선택</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>취소</button>
          <div className="ml-auto row gap-8">
            <button className="btn primary" onClick={() => { onClose(); toast.push("증빙이 첨부되었어요"); }}><Icon.Check size={14}/> 첨부 완료</button>
          </div>
        </div>
    </Drawer>
  );
};

/* ============ 엑셀 업로드 (실 기능) ============ */
/* 계정과목을 받는다. 없으면 일계표에서 상대 계정이 비어 차·대변이 안 맞는다 —
    수백 건을 한 번에 올리는 경로라 빠지면 그날들이 통째로 깨진다.
    회계 프로그램에서 뽑은 자료에는 대개 계정과목이 들어 있다. */
const IMPORT_TARGETS = ["사용 안함", "날짜", "거래처", "주문명", "입금/지출 구분", "비목", "계정과목", "금액", "공급가액", "부가세", "계좌", "메모"]
const guessTarget = (h) => {
  const s = String(h).replace(/\s/g, '')
  /* ⚠ 순서가 중요하다 — 먼저 걸리는 규칙이 이긴다.
     '공급가액' 열이 거래처 규칙의 '공급'(공급업체)에 먼저 잡혀 **금액이 거래처로 매핑**됐다.
     그래서 구체적인 열 이름(공급가액·부가세·계정과목)을 거래처보다 앞에 둔다. */
  if (/날짜|일자|date/i.test(s)) return "날짜"
  if (/공급가|과세표준|supply/i.test(s)) return "공급가액"
  if (/부가세|세액|vat/i.test(s)) return "부가세"
  if (/계정과목|계정코드|acct/i.test(s)) return "계정과목"
  if (/계좌|장부|통장|카드|account/i.test(s)) return "계좌"
  if (/거래처|상호|업체|공급처|공급자|vendor/i.test(s)) return "거래처"
  if (/주문|프로젝트|현장|contract/i.test(s)) return "주문명"
  if (/구분|입출|유형|type/i.test(s)) return "입금/지출 구분"
  if (/비목|항목|category/i.test(s)) return "비목"
  if (/금액|amount|합계/i.test(s)) return "금액"
  if (/메모|비고|적요|note/i.test(s)) return "메모"
  return "사용 안함"
}
const normDate = (v) => {
  if (v == null || v === '') return ''
  const s = String(v).trim()
  const m = s.match(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  const d = new Date(s)
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return ''
}
const normAmount = (v) => {
  if (v == null || v === '') return null
  const n = parseInt(String(v).replace(/[^0-9.-]/g, ''), 10)
  return isNaN(n) ? null : Math.abs(n)
}
const normKind = (v) => {
  const s = String(v || '').trim()
  if (/입금|수입|매출|수금|income/i.test(s)) return 'income'
  if (/지출|매입|출금|expense/i.test(s)) return 'expense'
  return null
}

export const ExcelScreen = () => {
  const toast = useToast()
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState([])
  const [mapping, setMapping] = useState([])
  const [defaultKind, setDefaultKind] = useState('expense')
  const [excluded, setExcluded] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  // 대량 등록분이 어느 계좌에서 오간 것인지 — 없으면 잔액에 반영되지 않는다
  const [importAccounts, setImportAccounts] = useState([])
  const [importAccountId, setImportAccountId] = useState("")
  useEffect(() => {
    api.getAccounts().then(list => {
      setImportAccounts(list)
      setImportAccountId(prev => prev || list.find(a => a.kind === "bank")?.id || "")
    })
  }, [])

  const onFile = async (f) => {
    if (!f) return
    setBusy(true); setResult(null)
    try {
      const { headers, rows } = await api.parseExcel(f)
      if (!headers.length) { toast.push("열을 인식하지 못했어요. 첫 행이 머리글인지 확인하세요."); setBusy(false); return }
      setFile({ name: f.name, size: f.size })
      setRawRows(rows)
      setMapping(headers.map(h => ({ excelCol: h, target: guessTarget(h) })))
      setExcluded(new Set())
    } catch (e) { toast.push(e.message || "파싱 실패", { tone: 'warn' }) }
    setBusy(false)
  }

  const reset = () => { setFile(null); setRawRows([]); setMapping([]); setExcluded(new Set()); setResult(null) }
  const colFor = (t) => mapping.find(m => m.target === t)?.excelCol
  const setMap = (i, k, v) => setMapping(ms => ms.map((m, idx) => idx === i ? { ...m, [k]: v } : m))

  /* 계좌 이름 → 계좌 id. 회계 프로그램에서 뽑은 통합 분개장은 여러 통장·카드가 섞여 있어,
     계좌를 하나로만 지정하면 그 수백 건이 전부 한 계좌에 붙어 자금일보·잔액이 통째로 틀린다. */
  const acctByName = useMemo(() => {
    const m = {}
    for (const a of importAccounts) { const k = String(a.name || '').replace(/\s/g, ''); if (k && !m[k]) m[k] = a.id }
    return m
  }, [importAccounts])
  const matchAccount = (v) => acctByName[String(v || '').replace(/\s/g, '')] || null

  const preview = rawRows.map((row, idx) => {
    const g = (t) => { const c = colFor(t); return c != null ? row[c] : '' }
    const date = normDate(g("날짜"))
    const kCol = colFor("입금/지출 구분")
    const kind = kCol != null ? normKind(row[kCol]) : defaultKind
    const amount = normAmount(g("금액"))
    const acctCol = colFor("계좌")
    const acctName = acctCol != null ? String(row[acctCol] || '').trim() : ''
    // 매핑했는데 이름이 안 맞으면 오류로 잡는다. 조용히 일괄 계좌로 흘리면 엉뚱한 통장 잔액이 된다.
    const account_id = acctName ? matchAccount(acctName) : null
    const errs = []
    if (!colFor("날짜") || !date) errs.push("날짜")
    if (!colFor("금액") || amount == null) errs.push("금액")
    if (!kind) errs.push("구분")
    if (acctName && !account_id) errs.push("계좌")
    return {
      idx, date, kind, amount, account_id, acctName,
      vendor: String(g("거래처") || '').trim(),
      contract: String(g("주문명") || '').trim(),
      category: String(g("비목") || '').trim(),
      account_code: String(g("계정과목") || '').trim(),
      supply_amount: normAmount(g("공급가액")),
      vat_amount: normAmount(g("부가세")),
      memo: String(g("메모") || '').trim(), errs,
    }
  })

  const active = preview.filter(r => !excluded.has(r.idx))
  const okRows = active.filter(r => r.errs.length === 0)
  const errRows = active.filter(r => r.errs.length > 0)
  const stage = result ? 4 : (file ? 3 : 1)

  const buckets = [
    { key: "날짜", label: "날짜 오류", fix: "날짜가 비었거나 형식을 인식 못했어요. 매핑을 다시 보거나 해당 행을 제외하세요." },
    { key: "금액", label: "금액 오류", fix: "금액이 비었거나 숫자가 아니에요. 매핑을 다시 보거나 해당 행을 제외하세요." },
    { key: "구분", label: "입금/지출 구분 오류", fix: "구분을 인식 못했어요. '구분' 매핑을 해제하면 위의 기본 유형이 적용돼요." },
    { key: "계좌", label: "계좌 이름을 못 찾음", fix: "엑셀의 계좌 이름과 기준정보의 계좌·카드 이름이 정확히 같아야 해요. 기준정보에 추가하거나, '계좌' 매핑을 해제하면 아래 일괄 계좌가 적용돼요." },
  ].map(b => ({ ...b, n: errRows.filter(r => r.errs.includes(b.key)).length })).filter(b => b.n > 0)

  const excludeErr = (key) => setExcluded(s => {
    const n = new Set(s)
    errRows.filter(r => r.errs.includes(key)).forEach(r => n.add(r.idx))
    return n
  })
  const unmapKind = () => setMapping(ms => ms.map(m => m.target === "입금/지출 구분" ? { ...m, target: "사용 안함" } : m))

  const onCommit = async () => {
    if (!okRows.length) return toast.push("등록할 정상 행이 없어요")
    // 계좌가 없으면 등록된 수백 건이 통째로 계좌 잔액에서 빠진다(서버도 400으로 막는다).
    // 행마다 계좌가 붙어 있으면 일괄 계좌는 필요 없다.
    if (!importAccountId && okRows.some(r => !r.account_id)) return toast.push("입출금 계좌를 선택해주세요")
    setBusy(true)
    /* 계정과목·공급가·부가세도 함께 보낸다. 안 보내면 서버가 금액에서 역산하는데,
       회계 프로그램에서 뽑은 자료는 이미 정확한 값을 갖고 있으므로 그걸 그대로 쓰는 게 맞다.
       계정과목이 빠지면 일계표에서 상대 계정이 비어 그날 차·대변이 안 맞는다. */
    const items = okRows.map(r => ({
      date: r.date, vendor: r.vendor, contract: r.contract, kind: r.kind,
      category: r.category, amount: r.amount, memo: r.memo,
      account_code: r.account_code || null,
      // 행별 계좌가 있으면 그걸 쓰고, 없는 행만 아래 일괄 계좌로 간다(서버도 같은 순서)
      account_id: r.account_id || null,
      supply_amount: r.supply_amount || null,
      vat_amount: r.vat_amount || null,
    }))
    const res = await api.commitImport(items, importAccountId)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || "등록 실패", { tone: 'warn' })
    setResult(res)
    toast.push(`${res.inserted}건이 등록됐어요`)
  }

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/transactions/import/template', { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob); const a = document.createElement('a')
      a.href = url; a.download = '거래내역_업로드_양식.xlsx'; a.click(); URL.revokeObjectURL(url)
    } catch { toast.push('양식 다운로드에 실패했어요', { tone: 'warn' }) }
  }

  return (
    <div className="fade-up import-wrap">
      <PageHeader
        title="엑셀 업로드"
        actions={<button className="btn" onClick={downloadTemplate}><Icon.Download/> 양식 다운로드</button>}
      />

      <div className="row gap-12" style={{ marginBottom: 20 }}>
        {[{ n: 1, t: "파일 업로드" }, { n: 2, t: "데이터 유형" }, { n: 3, t: "컬럼 매핑 · 미리보기" }, { n: 4, t: "일괄 등록" }].map((s, i, arr) => (
          <Fragment key={s.n}>
            <div className="row gap-8" style={{ opacity: stage >= s.n ? 1 : 0.4 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: stage >= s.n ? "var(--ink)" : "#fff", color: stage >= s.n ? "#fff" : "var(--muted)", border: "1px solid var(--line-strong)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12 }}>
                {stage > s.n ? <Icon.Check size={14}/> : s.n}
              </div>
              <div className={`text-sm ${stage >= s.n ? "fw-700" : "text-muted"}`}>{s.t}</div>
            </div>
            {i < arr.length - 1 && <div style={{ flex: 1, height: 1, background: "var(--line)" }}/>}
          </Fragment>
        ))}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={e => onFile(e.target.files[0])}/>

      {result ? (
        <div className="card card-pad fade-up" style={{ textAlign: "center", padding: "48px 24px", maxWidth: 520, margin: "0 auto" }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--pos-soft)", color: "var(--pos)", display: "grid", placeItems: "center", margin: "0 auto 16px" }}><Icon.Check size={24}/></div>
          <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>{result.inserted}건이 등록됐어요</div>
          {result.createdVendors?.length > 0 && (
            <div className="text-sm text-muted" style={{ marginBottom: 16 }}>신규 거래처 {result.createdVendors.length}곳 자동 등록: {result.createdVendors.slice(0, 5).join(', ')}{result.createdVendors.length > 5 ? ' 외' : ''}</div>
          )}
          {/* 서버가 건너뛴 행을 반드시 보여준다 — 예전엔 "N건 등록됐어요"만 떠서
              마감월·미래일자·금액오류로 빠진 행을 사용자가 영영 몰랐다. */}
          {(result.skippedClosed > 0 || result.skippedFuture > 0 || result.skippedAmount > 0) && (
            <div className="card card-pad" style={{ marginBottom: 16, textAlign: 'left', background: 'var(--warn-soft, var(--surface-2))' }}>
              <div className="fw-700 text-sm" style={{ marginBottom: 4 }}>
                {(result.skippedClosed || 0) + (result.skippedFuture || 0) + (result.skippedAmount || 0)}건은 등록하지 않았어요
              </div>
              <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
                {result.skippedClosed > 0 && <>· 마감된 달: {result.skippedClosed}건<br/></>}
                {result.skippedFuture > 0 && <>· 미래 날짜: {result.skippedFuture}건<br/></>}
                {result.skippedAmount > 0 && <>· 금액 오류(0·음수·과대): {result.skippedAmount}건<br/></>}
                해당 행을 고쳐서 다시 올려주세요.
              </div>
            </div>
          )}
          {/* 이름이 겹쳐 **일부러 안 이은** 것. 조용히 비우면 "왜 주문이 안 붙었지"가
              한참 뒤 계약 수익을 볼 때에야 드러난다. 올린 자리에서 바로 알린다.
              (아무거나 잇지 않는 이유 — 엉뚱한 주문에 붙으면 아무도 모른다.) */}
          {result.ambiguous?.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 16, textAlign: 'left', background: 'var(--surface-2)' }}>
              <div className="fw-700 text-sm" style={{ marginBottom: 4 }}>
                이름이 겹쳐 연결하지 못한 항목이 있어요
              </div>
              <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
                {result.ambiguous.slice(0, 6).join(' · ')}{result.ambiguous.length > 6 ? ' 외' : ''}<br/>
                같은 이름이 여럿이라 어느 것인지 정할 수 없었어요. 거래는 등록됐지만
                <b> 거래처·주문 연결은 비어 있습니다.</b> 기준정보에서 이름을 구분해 주시거나,
                거래내역에서 해당 건을 열어 직접 이어주세요.
              </div>
            </div>
          )}
          <button className="btn primary" onClick={reset}>새 파일 업로드</button>
        </div>
      ) : !file ? (
        <div className="card card-pad">
          <div className="drop" style={{ padding: 48, cursor: "pointer", textAlign: "center" }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
            <Icon.Excel size={36} style={{ color: "var(--pos)" }}/>
            <div className="fw-600" style={{ marginTop: 8 }}>{busy ? "분석 중..." : "엑셀·CSV 파일을 끌어다 놓거나 클릭해서 업로드"}</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>.xlsx · .xls · .csv · 최대 20MB · 첫 행은 머리글</div>
          </div>
        </div>
      ) : (
        <div className="col gap-16">
            <div className="card card-pad">
              <div className="row gap-12">
                <div style={{ width: 44, height: 44, borderRadius: 10, background: "#E7F4ED", color: "var(--pos)", display: "grid", placeItems: "center" }}><Icon.Excel size={22}/></div>
                <div style={{ minWidth: 0 }}>
                  <div className="fw-700" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
                  <div className="text-xs text-muted2">{Math.round(file.size / 1024)}KB · {rawRows.length}행 인식됨</div>
                </div>
                <div className="ml-auto row gap-6">
                  <button className="btn sm" onClick={() => fileRef.current?.click()}>다시 업로드</button>
                  <button className="btn ghost sm" onClick={reset}><Icon.Close size={14}/></button>
                </div>
              </div>
              <div style={{ height: 1, background: "var(--line)", margin: "14px 0" }}/>
              <div className="row gap-10" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <span className="text-sm fw-600">기본 데이터 유형</span>
                <span className="text-xs text-muted2">구분 컬럼을 매핑하면 그 값이 우선해요</span>
                <div className="row gap-6 ml-auto">
                  {[["expense", "지출"], ["income", "입금"]].map(([v, l]) => (
                    <button key={v} className={`chip ${defaultKind === v ? "active" : ""}`} onClick={() => setDefaultKind(v)}>{l}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card card-pad">
              <div className="section-title" style={{ marginBottom: 4 }}>컬럼 매핑</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>왼쪽은 엑셀 컬럼명(수정 가능), 오른쪽은 우리 항목으로 연결하세요.</div>
              <div className="table-scroll">
                <table className="table" style={{ marginTop: 6 }}>
                  <thead><tr><th style={{ width: 200 }}>엑셀 컬럼</th><th>샘플 값</th><th style={{ width: 220 }}>매핑 항목</th></tr></thead>
                  <tbody>
                    {mapping.map((m, i) => (
                      <tr key={i}>
                        <td><input className="input" value={m.excelCol} onChange={e => setMap(i, "excelCol", e.target.value)}/></td>
                        <td className="text-muted num text-sm" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(rawRows[0]?.[m.excelCol] ?? '—') || '—'}</td>
                        <td>
                          <div className="row gap-6" style={{ alignItems: "center" }}>
                            <Icon.Right size={12} className="text-muted2"/>
                            <div style={{ flex: 1 }}>
                              <Combobox value={m.target} onChange={v => setMap(i, "target", v)} allowAdd={false}
                                options={IMPORT_TARGETS.map(o => ({ value: o, label: o }))}/>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="row" style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 8 }}>
                <div className="section-title">미리보기</div>
                <div className="ml-auto row gap-8" style={{ flexWrap: "wrap", alignItems: "center" }}>
                  <span className="badge pos"><Icon.Check size={11}/> 정상 {okRows.length}</span>
                  <span className="badge neg"><Icon.Warn size={11}/> 오류 {errRows.length}</span>
                  {excluded.size > 0 && <span className="badge outline">제외 {excluded.size}</span>}
                  <Popover align="right" width={280}
                    trigger={<button className="icon-btn" title="안내"><Icon.Help size={16}/></button>}>
                    <div style={{ padding: 14 }}>
                      <div className="fw-700" style={{ marginBottom: 6 }}>미등록 거래처는 자동 등록</div>
                      <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>엑셀에만 있는 거래처는 등록 시 자동으로 거래처 목록에 추가돼요 (입금=발주처, 지출=매입처). 오류 행은 매핑을 바꾸거나 제외하면 바로 다시 검증됩니다.</div>
                    </div>
                  </Popover>
                </div>
              </div>

              {(buckets.length > 0 || excluded.size > 0) && (
                <div className="row gap-8" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)", flexWrap: "wrap", alignItems: "center" }}>
                  {buckets.length > 0 && <span className="text-xs fw-600 text-muted">오류 {errRows.length}건</span>}
                  {buckets.map((b, i) => (
                    <Fragment key={i}>
                      <button className="btn sm" onClick={() => excludeErr(b.key)}>{b.label} {b.n} 제외</button>
                      {b.key === "구분" && <button className="btn sm" onClick={unmapKind}>기본값 적용</button>}
                    </Fragment>
                  ))}
                  {excluded.size > 0 && <button className="btn ghost sm ml-auto" onClick={() => setExcluded(new Set())}>제외 해제 ({excluded.size})</button>}
                </div>
              )}

              <div className="table-scroll" style={{ maxHeight: 420 }}>
                <table className="table">
                  <thead><tr><th style={{ width: 40 }}>행</th><th>날짜</th><th>거래처</th><th>주문</th><th>구분</th><th>비목</th><th className="num-right">금액</th>{colFor("계좌") != null && <th>계좌</th>}<th>상태</th></tr></thead>
                  <tbody>
                    {preview.slice(0, 100).map((r) => {
                      const ex = excluded.has(r.idx)
                      return (
                        <tr key={r.idx} style={{ background: ex ? "var(--surface-2)" : r.errs.length ? "rgba(255,80,80,0.04)" : undefined, opacity: ex ? 0.5 : 1 }}>
                          <td className="num text-muted2">{r.idx + 2}</td>
                          <td className="num text-sm">{r.date || <span className="text-neg">—</span>}</td>
                          <td className="fw-600">{r.vendor || "—"}</td>
                          <td className="text-muted text-sm">{r.contract || "—"}</td>
                          <td>{r.kind ? <span className="badge outline">{r.kind === "income" ? "입금" : "지출"}</span> : <span className="text-neg text-xs">?</span>}</td>
                          <td className="text-sm">{r.category || "—"}</td>
                          <td className="num-cell num-right">{r.amount != null ? fmtNum(r.amount) : <span className="text-neg">—</span>}</td>
                          {colFor("계좌") != null && (
                            <td className="text-sm">
                              {!r.acctName ? <span className="text-muted2">일괄</span>
                                : r.account_id ? r.acctName
                                : <span className="text-neg">{r.acctName}</span>}
                            </td>
                          )}
                          <td>
                            {ex ? <span className="badge outline">제외</span>
                              : r.errs.length === 0 ? <span className="badge pos"><Icon.Check size={11}/> 정상</span>
                              : <span className="badge neg"><Icon.Warn size={11}/> {r.errs.join('·')} 오류</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ padding: 16, borderTop: "1px solid var(--line)", flexWrap: "wrap", gap: 12 }}>
                <div style={{ minWidth: 260 }}>
                  <label className="label" style={{ marginBottom: 6 }}>
                    입출금 계좌 {okRows.some(r => !r.account_id) && <span style={{ color: "var(--neg-ink)" }}>*</span>}
                  </label>
                  <Combobox value={importAccountId} onChange={setImportAccountId}
                    options={importAccounts.map(a => ({ value: a.id, label: a.name, sub: [a.kind === "card" ? "카드" : a.bankName, a.number].filter(Boolean).join(" ") }))}
                    placeholder="계좌 선택" allowAdd={false}/>
                  <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                    {colFor("계좌") != null
                      ? "계좌 열이 비어 있는 행에만 적용돼요."
                      : "이 거래들이 오간 계좌예요. 지정해야 계좌 잔액에 반영됩니다. 엑셀에 계좌 열이 있으면 '계좌'로 매핑하세요."}
                  </div>
                </div>
                <span className="text-sm text-muted">{preview.length > 100 ? `상위 100행 표시 · 전체 ${preview.length}행` : `전체 ${preview.length}행`}</span>
                <div className="ml-auto row gap-8">
                  <button className="btn" onClick={reset}>취소</button>
                  <button className="btn primary" disabled={busy || !okRows.length || (!importAccountId && okRows.some(r => !r.account_id))} style={{ opacity: (busy || !okRows.length || (!importAccountId && okRows.some(r => !r.account_id))) ? 0.5 : 1 }} onClick={onCommit}>
                    <Icon.Check size={14}/> {busy ? "등록 중..." : `정상 ${okRows.length}건 일괄 등록`}
                  </button>
                </div>
              </div>
            </div>
        </div>
      )}
    </div>
  )
}

/* ============ 보고서 ============ */

const RBar = ({ pct, tone = "pos" }) => (
  <div style={{ flex: 1, height: 5, borderRadius: 99, background: "var(--surface-3)", overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: `var(--${tone})`, borderRadius: 99 }}/>
  </div>
)

// 보고서 공용 원장 로더 — 거래내역을 한 번 불러 입금/지출과 월 목록으로 나눠 쓴다.
// (보고서마다 따로 부르면 같은 화면에서 여러 번 조회하게 된다)
const useLedger = () => {
  const [data, setData] = useState(null)
  useEffect(() => {
    api.getTransactions().then(rows => {
      const all = Array.isArray(rows) ? rows : []
      /* 보고서는 **손익만** 센다.
       * 예전엔 kind 하나로만 갈라서, 대출 실행(income)이 매출로·원금 상환과 예적금 납입이
       * 비용으로 잡혔다. 3억 대출을 받으면 발주처별 거래 현황에 은행이 발주처로 뜨고
       * 실현 매출이 3억 늘었다. 판정은 서버가 계정과목 대분류로 한다(lib/pnl.js와 같은 규칙). */
      /* ⚠ 청구서 정산 거래는 손익 판정에서 빠지지만 **여기서는 포함해야 한다.**
       *
       * 정산 거래의 상대 계정은 외상매출금·외상매입금(자산·부채)이다 — 매출·매입은
       * 청구서 발행 시점에 이미 인식됐고 정산은 그때 생긴 채권·채무가 사라지는 것이라
       * 회계적으로 옳다(일계표가 이 값으로 맞는다). 그런데 그 때문에 is_pnl 이 false 가 되어
       * 여기서 통째로 걸러졌고, **2억이 넘게 들어왔는데 보고서의 '총 입금'이 0원**이 됐다.
       *
       * 이 필터가 걸러내려던 것은 대출 실행·원금 상환·예적금 납입·투자 같은 **재무거래**다
       * (3억 대출이 실현 매출로 잡히던 문제). 그것들은 청구서와 무관하므로 invoiceId 가 없다.
       * 그래서 '손익이거나, 청구서 정산이거나'로 판정한다. */
      const list = all.filter(r => r.isPnl !== false || r.invoiceId)
      /* 걸러낸 것도 알려준다. 안 그러면 통장에서 돈이 나갔는데 보고서 그 달 지출이 '0원'이다.
         ((주)포커스윈 실자료: 4월에 재고 매입 331,240원이 나갔는데 월별 현황엔 −0 으로 보였다.
          숫자가 틀린 건 아니지만, 화면이 무엇을 뺐는지 말해주지 않으면 사용자는 누락으로 읽는다.) */
      const cut = all.filter(r => !(r.isPnl !== false || r.invoiceId))
      const sum = (a, k) => a.filter(r => r.kind === k).reduce((s, r) => s + (Number(r.amount) || 0), 0)
      setData({
        incomes:  list.filter(r => r.kind === 'income'),
        expenses: list.filter(r => r.kind === 'expense'),
        excluded: { n: cut.length, income: sum(cut, 'income'), expense: sum(cut, 'expense') },
        months: [...new Set(list.map(r => (r.date || '').slice(0, 7)).filter(Boolean))]
          .sort((a, b) => b.localeCompare(a)),
      })
    })
  }, [])
  return data
}

/* 보고서 기간 선택.
 *
 * 예전엔 **데이터에 존재하는 달 칩**만 늘어놓았다("전체 · 8월 · 7월"). 그래서
 *   · 한 달치만 있는 회사는 사실상 '전체'뿐이었고("기간이 다 전체밖에 없다"는 고객 지적)
 *   · 해가 넘어가면 '1월'이 작년인지 올해인지 알 수 없었고
 *   · 분기·반기처럼 실제로 필요한 구간을 고를 수 없었다.
 * 거래내역·청구서가 쓰는 것과 같은 방식(시작~끝 날짜 + 프리셋)으로 바꾼다.
 * 화면마다 다른 기간 필터를 배우게 하지 않는다.
 */
const REPORT_PRESETS = [
  { id: 'month', label: '이번 달' }, { id: 'last', label: '지난 달' },
  { id: 'quarter', label: '이번 분기' }, { id: 'year', label: '올해' },
]

const PeriodFilter = ({ value, onChange }) => {
  const r = value || { from: '', to: '' }
  return (
    <div className="row gap-8 no-print" style={{ marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="text-sm text-muted fw-600">기간</span>
      <DateInput className="input num" style={{ width: 150 }} value={r.from} max={r.to || undefined}
        onChange={e => onChange({ ...r, from: e.target.value })}/>
      <span className="text-muted fw-600">~</span>
      <DateInput className="input num" style={{ width: 150 }} value={r.to} min={r.from || undefined}
        onChange={e => onChange({ ...r, to: e.target.value })}/>
      {/* .tbar-presets 로 감싼다 — 고른 기간의 표시(.active) 스타일이 이 클래스 안에만 있어서,
          밖에 두면 클래스는 붙는데 아무 변화가 없다. 어느 기간을 보고 있는지 알 수 없었다.
          거래내역·청구서 툴바와 같은 부품을 쓰게 되니 표현도 저절로 같아진다. */}
      <div className="tbar-presets row gap-6" style={{ flexWrap: 'wrap' }}>
        {REPORT_PRESETS.map(p => {
          const pr = periodToRange(p.id)
          const on = r.from === pr.from && r.to === pr.to
          return (
            <button key={p.id} className={`btn ghost sm${on ? ' active' : ''}`} aria-pressed={on}
              onClick={() => onChange(pr)}>{p.label}</button>
          )
        })}
        <button className={`btn ghost sm${!r.from && !r.to ? ' active' : ''}`} aria-pressed={!r.from && !r.to}
          onClick={() => onChange({ from: '', to: '' })}>전체</button>
      </div>
    </div>
  )
}

/* 인쇄·엑셀에는 "언제 기준인지"가 남아야 한다. 컨트롤은 no-print 라 안 찍히므로
   기간 문구를 따로 둔다 — 기간이 안 적힌 보고서는 나중에 아무 근거가 되지 못한다. */
const PeriodNote = ({ period }) => (
  <div className="text-sm text-muted" style={{ marginBottom: 12 }}>기간: {periodLabelOf(period)}</div>
)

/** 기간(범위)으로 거른다. 범위가 비면 전체. 날짜가 없는 행은 기간을 걸었을 때 제외한다. */
const filterByPeriod = (rows, period, dateKey = "date") => {
  const { from, to } = period || {}
  if (!from && !to) return rows
  return (rows || []).filter(r => {
    const d = r?.[dateKey]
    if (!d) return false
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  })
}

/** 화면에 적을 기간 문구 — 인쇄물에 "언제 기준인지"가 없으면 보고서로 못 쓴다. */
const periodLabelOf = (p) => (!p?.from && !p?.to) ? '전체 기간'
  : `${p.from || '처음'} ~ ${p.to || '오늘'}`

// 완료 여부 판정 — 거래는 무공백 표준형('입금완료'/'지급완료'), 청구서는 공백형('입금 완료')을 쓴다.
// 보고서가 두 표기를 섞어 받으므로 공백을 지우고 비교한다(안 그러면 전부 미완료로 분류된다).
const isSettled = s => {
  const v = String(s || "").replace(/\s/g, "")
  return v === "입금완료" || v === "지급완료"
}

/* ⚠ 목록에서 뺀 보고서 — 실 데이터 연동이 안 된 것들이다.
 *   · 주문별 손익 현황 / 방산 납품 실적 — SAMPLE.contractSummary(빈 배열)를 읽어
 *     "총 수주 0원 · 총 손익 0원 · 평균 이익률 NaN%" 를 **확신 있게** 표시했다.
 *     0원과 NaN 은 "데이터가 없다"가 아니라 "회사가 0원을 벌었다"로 읽힌다 —
 *     비어 있는 화면보다 나쁘다.
 *   · 세무사 전달용 자료 — 건수·기간이 하드코딩이고 ZIP 버튼이 토스트만 띄운다.
 *   주문별 손익은 주문 화면에서 이미 실데이터로 볼 수 있다(주문 상세의 원가·손익).
 *   실구현하면 다시 넣는다. */
/* 보고서 목록은 **서버가 준다**(api.getReports).
 *
 * 예전엔 여기 하드코딩 배열이었다. 그래서 회사마다 다른 양식을 줄 방법이 없었고,
 * 아래 REPORT_VIEWS 에는 화면이 있는데 이 배열에 없어 **아무도 못 보는 보고서가 3개**
 * (주문별·방산·세무사 전달용) 방치돼 있었다 — 목록과 화면이 이미 따로 놀고 있었다는 뜻이다.
 *
 * 이제 목록은 서버(platform/reportCatalog.js), 화면은 여기(REPORT_VIEWS)다.
 * 서버가 아직 화면이 없는 key 를 줘도 화면은 **그 항목만 조용히 건너뛴다** —
 * 서버가 먼저 배포돼도 보고서 화면이 깨지지 않는다.
 *
 * 설계: docs/02-design/features/company-report-templates.design.md */

// ── 1. 월별 입금/지출 현황 ───────────────────────────────────
const ReportMonthly = ({ toast }) => {
  const [period, setPeriod] = useState({ from: "", to: "" })
  const led = useLedger()
  if (!led) return <Loading label="거래내역을 불러오는 중…"/>
  /* 완료된 거래만 센다 — 거래내역 화면(Ledger.jsx)이 그렇게 세므로 맞춰야 한다.
   * 안 맞추면 같은 달인데 두 화면의 숫자가 다르다(정기지출은 계좌 없이 '지급 대기'로 생길 수 있다). */
  const incomes  = filterByPeriod(led.incomes,  period).filter(r => isSettled(r.status))
  const expenses = filterByPeriod(led.expenses, period).filter(r => isSettled(r.status))

  const bucket = {}
  incomes.forEach(r => {
    const m = (r.date || '').slice(0, 7)
    if (!bucket[m]) bucket[m] = { income: 0, expense: 0 }
    bucket[m].income += r.amount
  })
  expenses.forEach(r => {
    const m = (r.date || '').slice(0, 7)
    if (!bucket[m]) bucket[m] = { income: 0, expense: 0 }
    bucket[m].expense += r.amount
  })
  const rows = Object.entries(bucket)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([m, v]) => ({ m, ...v, net: v.income - v.expense }))
  const maxVal = Math.max(...rows.flatMap(r => [r.income, r.expense]), 1)
  const totalIn  = rows.reduce((a, r) => a + r.income, 0)
  const totalOut = rows.reduce((a, r) => a + r.expense, 0)

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <PeriodNote period={period}/>
      <KpiRow cols={3} style={{ marginBottom: 24 }}>
        <Kpi label="총 입금" value={totalIn} tone="pos"/>
        <Kpi label="총 지출" value={totalOut}/>
        <Kpi label="순차액" value={totalIn - totalOut} tone={totalIn >= totalOut ? "pos" : "neg"}/>
      </KpiRow>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>월</th>
              <th className="num-right">입금</th>
              <th className="num-right">지출</th>
              <th className="num-right">차액</th>
              <th style={{ width: 200 }}>비교</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-600">{r.m}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>+{fmtNum(r.income)}</td>
                <td className="num-cell num-right">−{fmtNum(r.expense)}</td>
                <td className="num-cell num-right fw-700" style={{ color: r.net >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {r.net >= 0 ? "+" : "−"}{fmtNum(Math.abs(r.net))}
                </td>
                <td>
                  <div className="col gap-4">
                    <div className="row gap-6" style={{ alignItems: "center" }}>
                      <span style={{ width: 14, fontSize: 10, color: "var(--pos)" }}>입</span>
                      <RBar pct={(r.income / maxVal) * 100} tone="pos"/>
                    </div>
                    <div className="row gap-6" style={{ alignItems: "center" }}>
                      <span style={{ width: 14, fontSize: 10, color: "var(--muted)" }}>지</span>
                      <RBar pct={(r.expense / maxVal) * 100} tone="neg"/>
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {led.excluded?.n > 0 && (
        <div className="text-xs text-muted2" style={{ marginTop: 10, lineHeight: 1.7 }}>
          · 이 표는 <b>손익</b>만 셉니다. 재고 매입·대출 실행·원금 상환·예적금 납입처럼 비용·수익이 아닌 거래
          {led.excluded.expense > 0 && <> 지출 {fmtNum(led.excluded.expense)}원</>}
          {led.excluded.income > 0 && <>{led.excluded.expense > 0 ? ' ·' : ''} 입금 {fmtNum(led.excluded.income)}원</>}
          {' '}({led.excluded.n}건)은 빠져 있어요.
          <br/>· 통장에서 실제로 오간 전액은 <b>전체 거래내역</b>에서 보세요.
        </div>
      )}
    </div>
  )
}

// ── 2. 4대보험·원천세 신고 자료 ─────────────────────────────
const ReportTax4 = ({ toast }) => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [rows, setRows] = useState([])
  // 근로소득(급여대장, seq=0)만 집계 — 용역·일용·기타소득은 원천세 신고 구분이 달라 섞지 않는다.
  useEffect(() => { api.getPayroll(month, "labor").then(r => setRows(Array.isArray(r) ? r : [])) }, [month])

  const data = rows.map(r => ({ row: r, ...computeItems(r.items) }))
  const dedLabels = []
  data.forEach(d => d.calc.forEach(i => { if (i.kind === 'deduct' && !dedLabels.includes(i.label)) dedLabels.push(i.label) }))
  const amountOf = (d, label) => d.calc.filter(i => i.kind === 'deduct' && i.label === label).reduce((a, i) => a + i.amount, 0)
  const sumGross = data.reduce((a, d) => a + d.gross, 0)
  const sumDed = data.reduce((a, d) => a + d.deduction, 0)
  const sumNet = data.reduce((a, d) => a + d.net, 0)
  const sumLabel = (label) => data.reduce((a, d) => a + amountOf(d, label), 0)

  return (
    <div>
      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
        <div className="fw-700" style={{ fontSize: 15, minWidth: 100, textAlign: "center" }}>{monthLabel(month)}</div>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
        {/* 출력·내보내기는 보고서 공통 툴바(위쪽 '인쇄'·'엑셀')가 맡는다.
            여기 있던 '자료 출력'은 토스트만 띄우는 가짜 버튼이었고, 진짜 인쇄와 자리도 겹친다. */}
      </div>

      <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent", marginBottom: 16 }}>
        <div className="row gap-8">
          <Icon.Bell size={14}/>
          <span className="text-sm fw-600">근로소득 급여대장의 실제 지급·공제액을 집계했어요</span>
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>용역·일용·기타소득은 원천세 구분이 달라 제외됩니다 (인사관리 → 용역·일용 대장에서 확인)</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--muted-2)", padding: "44px 18px" }}>
          {monthLabel(month)} 급여대장이 없어요. 인사관리 → 급여대장에서 먼저 작성하세요.
        </div>
      ) : (
        <>
          <KpiRow cols={3} style={{ marginBottom: 24 }}>
            <Kpi label="급여 총액" value={sumGross}/>
            <Kpi label="공제 합계" value={sumDed} tone="warn"/>
            <Kpi label="실지급액" value={sumNet}/>
          </KpiRow>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>성명</th><th>직위</th>
                  <th className="num-right">급여총액</th>
                  {dedLabels.map(l => <th key={l} className="num-right">{l}</th>)}
                  <th className="num-right">실지급액</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d, i) => (
                  <tr key={i}>
                    <td className="fw-700">{d.row.name}</td>
                    <td className="text-sm text-muted">{d.row.role || "—"}</td>
                    <td className="num-cell num-right">{fmtNum(d.gross)}</td>
                    {dedLabels.map(l => <td key={l} className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(amountOf(d, l))}</td>)}
                    <td className="num-cell num-right fw-700">{fmtNum(d.net)}</td>
                  </tr>
                ))}
                <tr style={{ background: "var(--surface-2)" }}>
                  <td colSpan={2} className="fw-700">합계 {data.length}명</td>
                  <td className="num-cell num-right fw-700">{fmtNum(sumGross)}</td>
                  {dedLabels.map(l => <td key={l} className="num-cell num-right fw-700" style={{ color: "var(--warn-ink)" }}>{fmtNum(sumLabel(l))}</td>)}
                  <td className="num-cell num-right fw-700">{fmtNum(sumNet)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── 3. 주문별 수익 현황 ──────────────────────────────────────
/* 데이터는 **서버가 이미 계산한 것**을 그대로 쓴다(GET /contracts).
 *
 * 예전엔 이 화면이 `SAMPLE.contractSummary`(=[])를 읽어서 **늘 빈 표**였다.
 * 그렇다고 여기서 SQL을 새로 짜면 주문 화면과 숫자가 갈린다 — 같은 주문의 손익이
 * 화면마다 다르면 둘 다 못 믿게 된다. 그래서 집계는 routes/contracts.js 한 곳에 둔다.
 *
 * 서버가 지켜 주는 규칙 두 가지(여기서 다시 계산하면 안 되는 이유):
 *   · 손익은 **공급가액 기준**이다. VAT 포함으로 계산하면 정확히 10% 부풀려진다.
 *   · 원가는 `cost_contract_id`(원가 귀속)로 붙은 지출이지, `contract_id`(근거 주문)가 아니다.
 *     외주비 한 건은 외주 매입주문의 '지급'이면서 동시에 프로젝트 매출주문의 '원가'다.
 *
 * 매입 주문은 **뺀다.** 서버가 profit·cost 를 null 로 내리는데(나간 돈을 손해로 읽히게 하지
 * 않으려고), 그 행을 섞으면 손익 열이 빈 줄로 남아 합계가 무슨 뜻인지 알 수 없게 된다.
 */
const ReportContract = ({ toast }) => {
  const [rows, setRows] = useState(null)
  const [onlyOpen, setOnlyOpen] = useState(false)

  useEffect(() => {
    let alive = true
    api.getContracts().then(list => { if (alive) setRows(Array.isArray(list) ? list : []) })
    return () => { alive = false }
  }, [])

  if (rows === null) return <Loading label="주문을 불러오는 중…"/>

  const sales = rows
    .filter(c => !c.is_purchase)
    .filter(c => !onlyOpen || c.status === '진행중')
    .map(c => {
      const revenue = Number(c.in_supply || 0)     // 손익의 분모 — 받은 돈의 공급가액
      const cost = Number(c.cost_supply || 0)
      const profit = Number(c.profit || 0)
      return {
        ...c, revenue, cost, profit,
        // 매출이 0인 주문은 이익률이 성립하지 않는다 — 0으로 나눠 NaN·Infinity 를 찍지 않는다
        margin: revenue > 0 ? (profit / revenue) * 100 : null,
      }
    })
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))

  const sum = (f) => sales.reduce((a, r) => a + f(r), 0)
  const totalAmount = sum(r => Number(r.amount || 0))
  const totalRevenue = sum(r => r.revenue)
  const totalCost = sum(r => r.cost)
  const totalProfit = sum(r => r.profit)
  // 평균이 아니라 **합계 기준** 이익률이다. 주문별 이익률을 산술평균하면 작은 주문이 과대 반영된다.
  const totalMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : null

  return (
    <div>
      <div className="row gap-8 no-print" style={{ marginBottom: 16 }}>
        <button className={`chip ${!onlyOpen ? 'active' : ''}`} onClick={() => setOnlyOpen(false)}>전체</button>
        <button className={`chip ${onlyOpen ? 'active' : ''}`} onClick={() => setOnlyOpen(true)}>진행중만</button>
        <span className="text-sm text-muted" style={{ marginLeft: 8, alignSelf: 'center' }}>
          매출 주문 {sales.length}건
        </span>
      </div>

      <KpiRow cols={4} style={{ marginBottom: 24 }}>
        <Kpi label="총 수주금액" value={totalAmount} hint="계약서 금액(부가세 별도)"/>
        <Kpi label="받은 매출"   value={totalRevenue} hint="입금 완료분 · 공급가액"/>
        <Kpi label="투입 원가"   value={totalCost} tone="neg" hint="이 주문에 귀속된 지출"/>
        <Kpi label="손익"        value={totalProfit} tone={totalProfit < 0 ? 'neg' : 'pos'}
          badge={totalMargin == null ? undefined : `${totalMargin.toFixed(1)}%`}
          hint="받은 매출 − 투입 원가"/>
      </KpiRow>

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>주문</th>
                <th>거래처</th>
                <th className="num-right">수주금액</th>
                <th className="num-right">청구액</th>
                <th className="num-right">받은 매출</th>
                <th className="num-right">투입 원가</th>
                <th className="num-right">손익</th>
                <th style={{ width: 130 }}>이익률</th>
                <th className="num-right">미수금</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {sales.map(r => (
                <tr key={r.id}>
                  <td className="fw-700">{r.name}</td>
                  <td className="text-sm text-muted">{r.vendor_name || ''}</td>
                  <td className="num-cell num-right">{fmtNum(Number(r.amount || 0))}</td>
                  <td className="num-cell num-right text-muted">{fmtNum(Number(r.billed || 0))}</td>
                  <td className="num-cell num-right">{fmtNum(r.revenue)}</td>
                  <td className="num-cell num-right">{fmtNum(r.cost)}</td>
                  <td className="num-cell num-right fw-700"
                    style={{ color: r.profit < 0 ? "var(--neg)" : r.profit > 0 ? "var(--pos)" : undefined }}>
                    {r.profit < 0 ? '−' : r.profit > 0 ? '+' : ''}{fmtNum(Math.abs(r.profit))}
                  </td>
                  <td>
                    {/* 매출이 아직 없는 주문은 이익률 칸을 비운다 — 0%로 적으면 '본전'으로 읽힌다 */}
                    {r.margin == null
                      ? <span className="text-sm text-muted2">—</span>
                      : (
                        <div className="row gap-6" style={{ alignItems: "center" }}>
                          <span className="num text-sm fw-600"
                            style={{ color: r.margin < 0 ? "var(--neg)" : "var(--pos)", width: 44 }}>
                            {r.margin.toFixed(0)}%
                          </span>
                          {/* 손실이면 막대를 그리지 않는다 — 길이가 0이라 빈 막대가 되고,
                              그건 '적자'가 아니라 '데이터 없음'으로 읽힌다. 붉은 숫자가 이미 말한다. */}
                          {r.margin > 0 && <RBar pct={Math.min(100, r.margin)} tone="pos"/>}
                        </div>
                      )}
                  </td>
                  <td className="num-cell num-right text-sm">
                    {Number(r.ar_remain || 0) > 0 ? fmtNum(Number(r.ar_remain)) : ''}
                  </td>
                  <td><StatusBadge status={r.status}/></td>
                </tr>
              ))}
              {sales.length === 0 && (
                <tr><td colSpan={10} className="text-muted text-sm" style={{ textAlign: "center", padding: 24 }}>
                  매출 주문이 없어요.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-muted" style={{ marginTop: 12, lineHeight: 1.7 }}>
        · <b>손익 = 받은 매출 − 투입 원가</b>이고 둘 다 <b>공급가액</b> 기준입니다. 부가세는 받아서 내는 돈이라 손익이 아닙니다.<br/>
        · <b>받은 매출</b>은 입금이 완료된 것만, <b>투입 원가</b>는 지급이 완료된 것만 셉니다 — 예정은 아직 장부가 아닙니다.<br/>
        · <b>투입 원가</b>는 이 주문에 원가로 귀속시킨 지출입니다. 거래내역에서 주문을 연결해야 잡힙니다.<br/>
        · 매입(발주) 주문은 손익 개념이 성립하지 않아 이 표에서 뺐습니다.
      </div>
    </div>
  )
}

// ── 4. 비목별 지출 현황 ──────────────────────────────────────
const ReportCategory = ({ toast }) => {
  const [period, setPeriod] = useState({ from: "", to: "" })
  const led = useLedger()
  if (!led) return <Loading label="지출 내역을 불러오는 중…"/>
  // 완료된 지출만 — 거래내역 화면과 같은 기준(ReportMonthly 와 동일한 이유)
  const expenses = filterByPeriod(led.expenses, period).filter(r => isSettled(r.status))

  const bucket = {}
  expenses.forEach(r => {
    if (!bucket[r.category]) bucket[r.category] = 0
    bucket[r.category] += Number(r.amount) || 0
  })
  const total = Object.values(bucket).reduce((a, v) => a + v, 0)
  const rows = Object.entries(bucket)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, amt]) => ({ cat, amt, pct: total > 0 ? (amt / total) * 100 : 0 }))

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <PeriodNote period={period}/>
      <KpiRow cols={3} style={{ marginBottom: 24 }}>
        <Kpi label="총 지출"  value={total}/>
        <Kpi label="비목 수"  value={`${rows.length}개`} unit=""/>
        <Kpi label="최다 비목" value={rows[0]?.cat} unit=""/>
      </KpiRow>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>비목</th>
              <th className="num-right">금액</th>
              <th className="num-right" style={{ width: 70 }}>비중</th>
              <th style={{ width: 200 }}>비율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><span className="badge outline">{r.cat}</span></td>
                <td className="num-cell num-right fw-700">{fmtNum(r.amt)}</td>
                <td className="num-right text-muted">{r.pct.toFixed(1)}%</td>
                <td><RBar pct={r.pct} tone={i === 0 ? "neg" : "warn"}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 5. 발주처별 거래 현황 ────────────────────────────────────
const ReportVendor = ({ toast }) => {
  const [period, setPeriod] = useState({ from: "", to: "" })
  const led = useLedger()
  if (!led) return <Loading label="거래내역을 불러오는 중…"/>
  const incomes = filterByPeriod(led.incomes, period)

  // 실현 매출(입금 완료)과 미실현(예정·미수)을 분리
  const bucket = {}
  incomes.forEach(r => {
    if (!bucket[r.vendor]) bucket[r.vendor] = { realized: 0, pending: 0, count: 0 }
    const amt = Number(r.amount) || 0
    if (isSettled(r.status) || r.status === "일부 입금") bucket[r.vendor].realized += amt
    else                                                bucket[r.vendor].pending  += amt
    bucket[r.vendor].count++
  })
  const rows = Object.entries(bucket)
    .sort(([, a], [, b]) => (b.realized + b.pending) - (a.realized + a.pending))
    .map(([vendor, v]) => ({ vendor, ...v, total: v.realized + v.pending }))
  const totalRealized = rows.reduce((a, r) => a + r.realized, 0)
  const totalPending  = rows.reduce((a, r) => a + r.pending, 0)
  const grandTotal    = totalRealized + totalPending

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <PeriodNote period={period}/>
      <KpiRow cols={4} style={{ marginBottom: 24 }}>
        <Kpi label="발주처 수"    value={`${rows.length}개사`} unit=""/>
        <Kpi label="청구 합계"    value={grandTotal}/>
        <Kpi label="실현 매출"    value={totalRealized} tone="pos"/>
        <Kpi label="미입금 잔액"  value={totalPending}  tone="warn"/>
      </KpiRow>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>발주처</th>
              <th className="num-right">실현 매출</th>
              <th className="num-right">미입금</th>
              <th className="num-right" style={{ width: 60 }}>건수</th>
              <th className="num-right" style={{ width: 70 }}>비중</th>
              <th style={{ width: 180 }}>비율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.vendor}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{r.realized ? fmtNum(r.realized) : "—"}</td>
                <td className="num-cell num-right" style={{ color: r.pending ? "var(--warn)" : "var(--muted)" }}>
                  {r.pending ? fmtNum(r.pending) : "—"}
                </td>
                <td className="num-right text-muted">{r.count}건</td>
                <td className="num-right text-muted">{(r.total / grandTotal * 100).toFixed(1)}%</td>
                <td><RBar pct={(r.total / grandTotal) * 100} tone="brand"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 6. 미수금 현황 ───────────────────────────────────────────
// api.getReceivables()가 이 화면이 쓰는 { summary, rows } 형태를 그대로 돌려준다.
const ReportAR = ({ toast }) => {
  const [data, setData] = useState(null)
  useEffect(() => { api.getReceivables().then(setData) }, [])

  // 0원을 확신 있게 보여주면 사용자가 회수할 미수금이 없다고 오판한다. 로딩 중에는 숫자를 감춘다.
  if (!data) return <Loading label="미수금을 불러오는 중…"/>
  const { summary = {}, rows = [] } = data
  return (
    <div>
      <KpiRow cols={4} style={{ marginBottom: 24 }}>
        <Kpi label="미수금 합계"      value={summary.total}/>
        <Kpi label="이번 달 회수 예정" value={summary.thisMonth} tone="brand"/>
        <Kpi label="기한 초과"         value={summary.overdue}   tone="neg"/>
        <Kpi label="장기 미수"         value={summary.longOverdue} tone="neg"/>
      </KpiRow>
      {rows.length === 0 && (
        <div className="text-sm text-muted2" style={{ padding: 24, textAlign: "center" }}>
          미수금이 없어요. 발행한 청구서가 모두 입금 완료 상태입니다.
        </div>
      )}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>거래처</th><th>주문</th>
              <th className="num-right">청구금액</th>
              <th className="num-right">입금</th>
              <th className="num-right">잔액</th>
              <th>만기일</th>
              <th style={{ width: 70 }}>연체</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.vendor}</td>
                <td className="text-sm text-muted">{r.contract}</td>
                <td className="num-cell num-right">{fmtNum(r.billed)}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{r.paid ? fmtNum(r.paid) : "—"}</td>
                <td className="num-cell num-right fw-700">{fmtNum(r.remain)}</td>
                <td className="text-sm">{r.due}</td>
                <td className="num-cell num-right">
                  {r.delay > 0 ? <span className="badge neg">{r.delay}일</span> : <span className="text-muted">—</span>}
                </td>
                <td><StatusBadge status={r.status}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 7. 외주가공비 분석 ───────────────────────────────────────
const ReportSubcontract = ({ toast }) => {
  const [period, setPeriod] = useState({ from: "", to: "" })
  const led = useLedger()
  if (!led) return <Loading label="외주가공비를 불러오는 중…"/>
  // expenses만 사용 — payables와 중복 집계 방지 (payables는 미지급 잔액 뷰)
  const subRows = filterByPeriod(led.expenses, period).filter(r => r.category === "외주가공비")

  const bucket = {}
  subRows.forEach(r => {
    if (!bucket[r.vendor]) bucket[r.vendor] = { paid: 0, pending: 0, count: 0 }
    const amt = Number(r.amount) || 0
    if (isSettled(r.status)) bucket[r.vendor].paid    += amt
    else                     bucket[r.vendor].pending += amt
    bucket[r.vendor].count++
  })
  const rows = Object.entries(bucket)
    .sort(([, a], [, b]) => (b.paid + b.pending) - (a.paid + a.pending))
    .map(([vendor, v]) => ({ vendor, ...v, total: v.paid + v.pending }))
  const total    = rows.reduce((a, r) => a + r.total, 0)
  const totalPending = rows.reduce((a, r) => a + r.pending, 0)
  const totalExp = filterByPeriod(led.expenses, period).reduce((a, r) => a + (Number(r.amount) || 0), 0)

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <PeriodNote period={period}/>
      <KpiRow cols={4} style={{ marginBottom: 24 }}>
        <Kpi label="협력사 수"      value={`${rows.length}개사`} unit=""/>
        <Kpi label="외주가공비 합계" value={total}/>
        <Kpi label="미지급 잔액"    value={totalPending} tone="warn"/>
        <Kpi label="총 지출 대비"   value={totalExp > 0 ? parseFloat((total / totalExp * 100).toFixed(1)) : 0} unit="%"/>
      </KpiRow>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>협력사</th>
              <th className="num-right">지급 완료</th>
              <th className="num-right">미지급</th>
              <th className="num-right" style={{ width: 60 }}>건수</th>
              <th className="num-right" style={{ width: 70 }}>비중</th>
              <th style={{ width: 180 }}>비율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.vendor}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{r.paid ? fmtNum(r.paid) : "—"}</td>
                <td className="num-cell num-right" style={{ color: r.pending ? "var(--warn)" : "var(--muted)" }}>
                  {r.pending ? fmtNum(r.pending) : "—"}
                </td>
                <td className="num-right text-muted">{r.count}건</td>
                <td className="num-right text-muted">{total > 0 ? (r.total / total * 100).toFixed(1) : 0}%</td>
                <td><RBar pct={total > 0 ? (r.total / total) * 100 : 0} tone="warn"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 8. 방산 납품 실적 보고서 ────────────────────────────────
const ReportDefense = ({ toast }) => {
  const [expanded, setExpanded] = useState(null)
  const rows = SAMPLE.contractSummary
  const totalAmount = rows.reduce((a, r) => a + r.amount, 0)
  const totalDone   = rows.reduce((a, r) => a + r.inDone, 0)

  return (
    <div>
      <div className="card card-pad" style={{ background: "var(--surface-2)", marginBottom: 24 }}>
        <div className="row gap-12" style={{ marginBottom: 8 }}>
          <div className="text-sm fw-700">방산물자 납품 이행률</div>
          <span className="num fw-700 ml-auto" style={{ color: "var(--pos)" }}>{(totalDone / totalAmount * 100).toFixed(1)}%</span>
        </div>
        <RBar pct={(totalDone / totalAmount) * 100} tone="pos"/>
      </div>
      <KpiRow cols={3} style={{ marginBottom: 24 }}>
        <Kpi label="총 수주금액"   value={totalAmount}/>
        <Kpi label="납품 완료금액" value={totalDone} tone="pos"/>
        <Kpi label="잔여금액"      value={totalAmount - totalDone}/>
      </KpiRow>
      <div className="col gap-12">
        {rows.map((r, i) => {
          const pct  = r.inDone / r.amount * 100
          const open = expanded === i
          return (
            <div key={i} className="card" style={{ overflow: "hidden" }}>
              {/* 주문 헤더 */}
              <button
                onClick={() => setExpanded(open ? null : i)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", borderBottom: open ? "1px solid var(--line)" : "none" }}
              >
                <div style={{ textAlign: "left", flex: 1 }}>
                  <div className="fw-700 text-sm">{r.contractNo}</div>
                  <div className="text-sm text-muted" style={{ marginTop: 2 }}>{r.buyer} · {(r.name || '').split("(")[0].trim()}</div>
                </div>
                <div style={{ textAlign: "right", minWidth: 100 }}>
                  <div className="num fw-700" style={{ fontSize: 15 }}>{fmtNum(r.amount)}원</div>
                  <div className="text-xs text-muted" style={{ marginTop: 2 }}>이행 {pct.toFixed(0)}%</div>
                </div>
                <div style={{ width: 80 }}><RBar pct={pct} tone="pos"/></div>
                <StatusBadge status={r.status}/>
                <Icon.Right size={13} style={{ color: "var(--muted-2)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", flexShrink: 0 }}/>
              </button>
              {/* 품목 테이블 */}
              {open && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>품목번호</th>
                      <th>품목명</th>
                      <th className="num-right">수량</th>
                      <th>단위</th>
                      <th className="num-right">단가</th>
                      <th className="num-right">금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.items || []).map((it, j) => (
                      <tr key={j}>
                        <td className="text-sm text-muted">{it.no}</td>
                        <td className="fw-600 text-sm">{it.name}</td>
                        <td className="num-cell num-right">{it.qty.toLocaleString()}</td>
                        <td className="text-sm text-muted">{it.unit}</td>
                        <td className="num-cell num-right">{fmtNum(it.unitPrice)}</td>
                        <td className="num-cell num-right fw-700">{fmtNum(it.total)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: "var(--surface-2)" }}>
                      <td colSpan={5} className="fw-700 text-sm">합계</td>
                      <td className="num-cell num-right fw-700">{fmtNum((r.items || []).reduce((a, it) => a + it.total, 0))}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 9. 세무사 전달용 자료 ────────────────────────────────────
/* 세무사 전달용 자료.
 *
 * ── 예전 상태 ──
 * 건수가 **코드에 박혀 있었다**: 16건·7건·5건·8건·7명·1건·누락 3건.
 * 실데이터와 아무 상관이 없는데 초록 체크까지 붙어 "준비 완료"로 읽혔고,
 * 'ZIP 내려받기'는 토스트만 띄웠다. 신고철에 이걸 믿고 넘어가면 자료가 빠진 채 넘어간다 —
 * 화면이 거짓을 말하는, 이 코드베이스에서 제일 나쁜 종류다.
 *
 * ── 지금 ──
 * 서버(lib/taxofficePack.js)가 실제로 세고, 엑셀 한 권(종류별 시트)으로 내려받는다.
 * ZIP 이 아닌 이유: 받는 쪽은 결국 풀어서 하나씩 열게 되고, 우리는 압축 라이브러리를 더 들여야 한다.
 *
 * 달 구간은 **회계 마감일**을 따른다(25일 마감이면 7월분 = 6/26~7/25). 그래서 구간을 화면에 적는다 —
 * 받는 쪽이 달력월로 오해하면 대조가 안 맞는다.
 */
const ReportTaxOffice = ({ toast, registerExport }) => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [pack, setPack] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setPack(null)
    api.getTaxofficePack(month).then(p => { if (alive) setPack(p) })
    return () => { alive = false }
  }, [month])

  const download = async () => {
    setBusy(true)
    const r = await api.downloadTaxofficeXlsx(month)
    setBusy(false)
    if (!r.ok) toast.push(r.error || '내려받기에 실패했어요', { tone: 'warn' })
    else toast.push(`${monthLabel(month)} 자료를 엑셀로 내려받았어요`)
  }

  /* 껍데기의 '엑셀' 버튼이 이 함수를 쓴다 — 같은 화면에 '엑셀'이 둘이면
     어느 걸 눌러야 하는지 매번 갈린다(차입금에서 같은 문제를 고쳤다). */
  useEffect(() => {
    registerExport?.(download)
    return () => registerExport?.(null)
  }, [registerExport, month])

  const notReady = (pack?.sections || []).filter(s => !s.ready)

  return (
    <div>
      <div className="row gap-12 no-print" style={{ marginBottom: 20, alignItems: "center" }}>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
        <div className="fw-700" style={{ fontSize: 15, minWidth: 100, textAlign: "center" }}>{monthLabel(month)}</div>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
        {/* 마감일이 있는 회사는 '7월분'이 6/26~7/25 다 — 구간을 적어야 받는 쪽이 대조할 수 있다 */}
        {pack && (
          <span className="text-sm text-muted">집계 구간 {pack.from} ~ {pack.to}</span>
        )}
        {/* 내려받기는 위 '엑셀' 버튼 하나로 모았다(registerExport) */}
        {busy && <span className="text-sm text-muted ml-auto">엑셀을 만드는 중…</span>}
      </div>

      {!pack ? <Loading label="자료를 세는 중…"/> : (
        <>
          <div className="card" style={{ overflow: "hidden", marginBottom: 16 }}>
            <table className="table">
              <thead><tr><th>항목</th><th className="num-right" style={{ width: 120 }}>건수</th><th style={{ width: 130 }}>상태</th></tr></thead>
              <tbody>
                {pack.sections.map(s => (
                  <tr key={s.key}>
                    <td className="fw-600 text-sm">{s.label}</td>
                    <td className="num-cell num-right">{fmtNum(s.count)}{s.unit}</td>
                    <td>
                      {/* 정상이면 표식을 달지 않는다 — 전부 초록 체크가 붙으면 정작 문제가 안 보인다 */}
                      {s.ready ? <span className="text-sm text-muted2">—</span>
                        : <span className="badge warn" style={{ fontSize: 11 }}>확인 필요</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {notReady.length > 0 && (
            <div className="alert-row" style={{ background: "var(--warn-soft)", borderColor: "transparent" }}>
              <Icon.Warn/>
              <div>
                <div className="lead">{notReady.map(s => s.label).join(' · ')}</div>
                <div className="body">
                  증빙 누락은 채우고, 0건인 항목은 입력이 빠지지 않았는지 확인한 뒤 넘기세요.
                </div>
              </div>
            </div>
          )}

          <div className="text-xs text-muted" style={{ marginTop: 12, lineHeight: 1.7 }}>
            · 입출금은 <b>완료된 거래만</b> 담습니다(예정 제외).<br/>
            · 급여대장은 <b>월분</b> 기준이라 위 집계 구간과 다를 수 있습니다 — 급여는 '7월분'으로 신고하지 '6/26~7/25분'으로 신고하지 않습니다.<br/>
            · <b>원천징수이행상황신고서 서식은 만들지 않습니다.</b> 대상 급여 명단만 담습니다 — 서식과 세율은 해마다 바뀌어 세무사가 작성할 자리입니다.
          </div>
        </>
      )}
    </div>
  )
}

// ── 10. 부가세 신고 자료 ─────────────────────────────────────
/* 분기 → 부가세 과세기간·신고기한.
 * 부가세는 반기(1기 1~6월 / 2기 7~12월)를 다시 예정·확정으로 나눈다. 분기와 '기'가 1:1이 아니다.
 *   1~3월  = 1기 예정 (기한 4/25)      4~6월  = 1기 확정 (기한 7/25)
 *   7~9월  = 2기 예정 (기한 10/25)     10~12월 = 2기 확정 (기한 다음해 1/25)
 * ⚠ 예전 화면은 4~6월을 '2기 예정신고'라고 적어 두었는데 틀린 표기다(1기 확정이다).
 *   신고 기한을 잘못 알려주면 가산세로 이어지므로 여기서 바로잡는다. */
function vatPeriodOf(quarter, year) {
  const M = {
    Q1: { from: `${year}.01.01`, to: `${year}.03.31`, label: '1기 예정신고', due: `${year}년 4월 25일` },
    Q2: { from: `${year}.04.01`, to: `${year}.06.30`, label: '1기 확정신고', due: `${year}년 7월 25일` },
    Q3: { from: `${year}.07.01`, to: `${year}.09.30`, label: '2기 예정신고', due: `${year}년 10월 25일` },
    Q4: { from: `${year}.10.01`, to: `${year}.12.31`, label: '2기 확정신고', due: `${year + 1}년 1월 25일` },
  }
  return M[quarter] || M.Q1
}

const ReportVAT = ({ toast, registerExport }) => {
  const [quarter, setQuarter] = useState("Q2")
  const [vatData, setVatData] = useState(null)
  // getVatSummary 가 올해 기준으로 조회한다 — 기간 표시도 같은 해를 쓴다
  const year = new Date().getFullYear()
  const vatPeriod = vatPeriodOf(quarter, year)

  useEffect(() => {
    import('../lib/api').then(({ api }) => {
      api.getVatSummary(quarter).then(setVatData)
    })
  }, [quarter])

  /* 위 '엑셀' 버튼이 **서버가 만든 신고 자료**를 내려주게 한다.
     등록하지 않으면 화면 표를 긁어 CSV 로 뱉는 공용 경로로 흘러간다(lib/export.js) —
     서식도 합계도 없고 신고서 순서로 서 있지도 않아, 받는 사람이 결국 손으로 다시 만든다. */
  useEffect(() => {
    const download = async () => {
      const res = await api.downloadVatXlsx(quarter, year)
      if (!res.ok) toast?.push(res.error || '내려받기에 실패했어요', { tone: 'warn' })
      return true   // 공용 CSV 경로로 넘어가지 않게 '처리했다'를 알린다
    }
    registerExport?.(download)
    return () => registerExport?.(null)
  }, [registerExport, quarter, year])

  if (!vatData) return <div className="text-muted text-sm" style={{ padding: 24 }}>불러오는 중...</div>

  const { salesVat, purchaseVat, netVat, salesInvoices, purchaseInvoices } = vatData
  const QUARTER_LABEL = { Q1: "1분기 (1~3월)", Q2: "2분기 (4~6월)", Q3: "3분기 (7~9월)", Q4: "4분기 (10~12월)" }
  const salesTotal = salesInvoices.reduce((a, r) => a + r.supplyAmount, 0)
  const purchaseTotal = purchaseInvoices.reduce((a, r) => a + r.supplyAmount, 0)
  // 영세율 안내는 실제 영세율 매출이 있을 때만 — 아래 배너 주석 참고
  const zeroRated = salesInvoices.filter(r => r.taxType === '영세')

  return (
    <div>
      {/* 분기 선택 */}
      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <span className="text-sm text-muted fw-600" style={{ lineHeight: "28px" }}>신고 분기</span>
        {["Q1", "Q2", "Q3", "Q4"].map(q => (
          <button key={q} className={`chip${quarter === q ? " active" : ""}`} onClick={() => setQuarter(q)}>
            {QUARTER_LABEL[q]}
          </button>
        ))}
      </div>

      {/* 신고 기간 — 고른 분기에서 계산한다.
          예전엔 "2026.04.01 ~ 2026.06.30 (2기 예정신고) · 기한 2026년 7월 25일"이 **글자로 박혀** 있어서
          1·3·4분기를 골라도 2분기 날짜가 그대로 남았다. 신고 기한을 잘못 알려주는 건 그냥 틀린 정보다. */}
      <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent", marginBottom: 12 }}>
        <div className="row gap-8" style={{ flexWrap: "wrap" }}>
          <Icon.Bell size={14}/>
          <span className="text-sm fw-600">신고 기간: {vatPeriod.from} ~ {vatPeriod.to} ({vatPeriod.label})</span>
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>신고 기한: {vatPeriod.due}</span>
        </div>
      </div>

      {/* 영세율 안내 — **영세율 청구서가 실제로 있을 때만** 뜬다.
       *
       * 예전엔 조건 없이 "방산업체 영세율(0%) 주의 — 한화에어로스페이스·LIG넥스원 등…"이
       * 모든 회사, 모든 분기에 떴다. 초기 프로토타입(방산 납품업체)의 문구가 그대로 남은 것인데,
       * 지금은 여러 회사가 쓰는 서비스다. 방산과 무관한 회사의 신고 화면 맨 위를 매번
       * 남의 업종 경고가 차지했다.
       *
       * 업종(company_info.biz_item)으로 거르는 방법도 있지만 **장부가 더 정확하다** —
       * 영세율은 방산뿐 아니라 수출에도 적용되고, 방산업체라도 그 분기에 영세율 건이
       * 없으면 안내할 게 없다. 그래서 '이 분기에 영세율로 끊은 청구서가 있나'로 판단한다. */}
      {zeroRated.length > 0 && (
        <div className="card card-pad" style={{ background: "oklch(0.98 0.015 60)", borderColor: "oklch(0.88 0.06 60)", marginBottom: 16 }}>
          <div className="row gap-8" style={{ alignItems: "flex-start" }}>
            <Icon.Warn size={15} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }}/>
            <div>
              <div className="text-sm fw-700" style={{ color: "oklch(0.5 0.12 55)", marginBottom: 4 }}>
                영세율(0%) 매출 {zeroRated.length}건이 포함돼 있어요 — 세무사 확인 필요
              </div>
              <div className="text-xs" style={{ color: "oklch(0.55 0.08 55)", lineHeight: 1.6 }}>
                수출·방산 납품 등 영세율 적용 매출은 매출세액이 0원이고 매입세액은 환급 대상이 됩니다.
                영세율은 증빙(수출신고필증·구매확인서 등)이 있어야 인정되니 신고 전 담당 세무사와 확인하세요.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 요약 카드 */}
      <KpiRow cols={3} style={{ marginBottom: 24 }}>
        <Kpi label="매출세액 (참고)" value={salesVat}                            tone="pos"/>
        <Kpi label="매입세액 (참고)" value={purchaseVat}                         tone="neg"/>
        <Kpi label="납부세액 (참고)" value={netVat} tone={netVat > 0 ? "neg" : "pos"}/>
      </KpiRow>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* 매출 */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="section-title" style={{ fontSize: 14 }}>매출 (세금계산서 발행)</div>
            <span className="badge pos ml-auto">{fmtNum(salesTotal)}원</span>
          </div>
          <table className="table">
            <thead><tr><th>거래처</th><th className="num-right">공급가액</th><th className="num-right">산출세액*</th></tr></thead>
            <tbody>
              {salesInvoices.map((r, i) => (
                <tr key={i}>
                  <td className="fw-600 text-sm">{r.vendor}</td>
                  <td className="num-cell num-right text-sm">{fmtNum(r.supplyAmount)}</td>
                  <td className="num-cell num-right text-sm" style={{ color: "var(--pos)" }}>{fmtNum(r.vatAmount)}</td>
                </tr>
              ))}
              {salesInvoices.length === 0 && (
                <tr><td colSpan={3} className="text-muted text-sm" style={{ textAlign: "center", padding: 16 }}>해당 분기 매출 세금계산서 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 매입 */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="section-title" style={{ fontSize: 14 }}>매입 (세금계산서 수취)</div>
            <span className="badge warn ml-auto">{fmtNum(purchaseTotal)}원</span>
          </div>
          <table className="table">
            <thead><tr><th>거래처</th><th className="num-right">공급가액</th><th className="num-right">산출세액*</th></tr></thead>
            <tbody>
              {purchaseInvoices.map((r, i) => (
                <tr key={i}>
                  <td className="fw-600 text-sm">{r.vendor}</td>
                  <td className="num-cell num-right text-sm">{fmtNum(r.supplyAmount)}</td>
                  <td className="num-cell num-right text-sm" style={{ color: "var(--neg)" }}>{fmtNum(r.vatAmount)}</td>
                </tr>
              ))}
              {purchaseInvoices.length === 0 && (
                <tr><td colSpan={3} className="text-muted text-sm" style={{ textAlign: "center", padding: 16 }}>해당 분기 매입 세금계산서 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-muted" style={{ marginTop: 12 }}>
        * 산출세액은 공급가액 × 10% 단순 계산치입니다. 영세율·면세 항목은 별도 적용이 필요합니다.
      </div>
    </div>
  )
}

// ── 11. 자금관리표 ───────────────────────────────────────────
/* 대표가 쓰던 엑셀(`자금(현금)관리2026.xlsx`)의 칸 배치를 그대로 옮긴 한 장.
 *
 * 자금 현황 화면과 **숫자는 같고 모양이 다르다**(서버도 같은 lib 을 쓴다).
 *   자금 현황  화면에서 읽는 문서 — 달력·시간축·펼쳐보기
 *   자금관리표 종이로 넘기는 문서 — 엑셀 칸 배치를 지킨다
 * 몇 년째 그 자리로 봐 온 문서라, 같은 숫자라도 자리가 바뀌면 못 읽는다.
 *
 * 원본에 없던 걸 하나 더했다: **들어온 돈**.
 * 원본은 <입금 예정금액>(들어올 돈)만 있어서 "이번 달에 얼마나 들어왔나"를
 * 통장을 따로 열어 봐야 했다.
 */
const FS_NEG = { color: 'var(--neg)' }
const fsNum = (n) => {
  const v = Number(n) || 0
  return <span className="num" style={v < 0 ? FS_NEG : undefined}>{v < 0 ? '−' : ''}{fmtNum(Math.abs(v))}</span>
}

/* 나갈 항목 칸.
 *
 * 원본 엑셀은 계좌당 8칸이었는데 실제 데이터는 **44개**까지 나온다(정기지출·상환 회차).
 * 다 뿌리면 한 행이 화면 절반을 먹어 표가 아니라 벽이 된다.
 * 금액 큰 순 5개만 두고 나머지는 접는다 — 자금표에서 먼저 봐야 할 건 큰 돈이다.
 * 접힌 건 **숨긴 게 아니라 접은 것**이고(눌러 펼친다), 엑셀에는 전부 들어간다. */
const FS_TOP = 5
const FundSheetOutItems = ({ items }) => {
  const [open, setOpen] = useState(false)
  if (!items.length) return <span className="text-muted2">—</span>
  const sorted = [...items].sort((a, b) => b.amount - a.amount)
  const shown = open ? sorted : sorted.slice(0, FS_TOP)
  const rest = sorted.length - shown.length
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {shown.map((it, i) => (
        <span key={`${it.label}-${i}`} className="badge" style={{ fontSize: 11 }}>
          {it.label} <b className="num" style={{ marginLeft: 4 }}>{fmtNum(it.amount)}</b>
        </span>
      ))}
      {rest > 0 && (
        <button className="badge" style={{ fontSize: 11, cursor: 'pointer', border: 0 }}
          onClick={() => setOpen(true)}>외 {rest}건 ▾</button>
      )}
      {open && sorted.length > FS_TOP && (
        <button className="badge" style={{ fontSize: 11, cursor: 'pointer', border: 0 }}
          onClick={() => setOpen(false)}>접기 ▴</button>
      )}
    </div>
  )
}

const FundSheetAccounts = ({ title, g }) => {
  if (!g.rows.length) return null
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
      <div className="row card-pad" style={{ paddingBottom: 10, alignItems: 'baseline' }}>
        <div className="fw-700">{title}</div>
        <div className="ml-auto text-sm text-muted">계좌 {g.rows.length}개</div>
      </div>
      <div className="table-scroll" style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: 1000 }}>
          <thead>
            <tr>
              <th style={{ minWidth: 150 }}>계좌</th>
              <th className="num-right" style={{ width: 130 }}>잔액</th>
              <th className="num-right" style={{ width: 120, borderLeft: '1px solid var(--line)' }}>들어온 돈</th>
              <th className="num-right" style={{ width: 120 }}>나간 돈</th>
              <th style={{ borderLeft: '1px solid var(--line)' }}>나갈 항목</th>
              <th className="num-right" style={{ width: 130 }}>나갈 합계</th>
              <th className="num-right" style={{ width: 130 }}>차액</th>
            </tr>
          </thead>
          <tbody>
            {g.rows.map(r => (
              <tr key={r.id}>
                <td className="fw-600">{r.name}</td>
                <td className="num-cell num-right">{fsNum(r.balance)}</td>
                {/* 실적 두 칸 — 원본 엑셀에 없던 열이다 */}
                <td className="num-cell num-right text-muted" style={{ borderLeft: '1px solid var(--line)' }}>
                  {r.actualIn ? fmtNum(r.actualIn) : ''}</td>
                <td className="num-cell num-right text-muted">{r.actualOut ? fmtNum(r.actualOut) : ''}</td>
                <td className="text-sm" style={{ borderLeft: '1px solid var(--line)' }}>
                  <FundSheetOutItems items={r.outItems}/>
                </td>
                <td className="num-cell num-right">{r.outTotal ? fmtNum(r.outTotal) : ''}</td>
                <td className="num-cell num-right fw-700">{fsNum(r.after)}</td>
              </tr>
            ))}
            <tr style={{ background: 'var(--surface-2)' }}>
              <td className="fw-700">합계</td>
              <td className="num-cell num-right fw-700">{fsNum(g.total.balance)}</td>
              <td className="num-cell num-right" style={{ borderLeft: '1px solid var(--line)' }}>{fmtNum(g.total.actualIn)}</td>
              <td className="num-cell num-right">{fmtNum(g.total.actualOut)}</td>
              <td style={{ borderLeft: '1px solid var(--line)' }}/>
              <td className="num-cell num-right fw-700">{fmtNum(g.total.outTotal)}</td>
              <td className="num-cell num-right fw-700">{fsNum(g.total.after)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

const ReportFundSheet = ({ toast, registerExport }) => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setD(null)
    api.getFundSheet(month).then(x => { if (alive) setD(x) })
    return () => { alive = false }
  }, [month])

  const download = async () => {
    setBusy(true)
    const r = await api.downloadFundSheetXlsx(month)
    setBusy(false)
    if (!r.ok) toast.push(r.error || '내려받기에 실패했어요', { tone: 'warn' })
    else toast.push(`${monthLabel(month)} 자금관리표를 내려받았어요`)
  }
  /* 껍데기의 '엑셀' 버튼이 이 함수를 쓴다 — 같은 화면에 '엑셀'이 둘이면
     어느 걸 눌러야 하는지 매번 갈린다(차입금에서 같은 문제를 고쳤다). */
  useEffect(() => {
    registerExport?.(download)
    return () => registerExport?.(null)
  }, [registerExport, month])

  if (!d) {
    return (
      <div>
        <div className="row gap-12 no-print" style={{ marginBottom: 20, alignItems: 'center' }}>
          <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
          <div className="fw-700" style={{ fontSize: 15, minWidth: 100, textAlign: 'center' }}>{monthLabel(month)}</div>
          <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
        </div>
        <Loading label="자금 자료를 모으는 중…"/>
      </div>
    )
  }

  const S = d.summary
  return (
    <div>
      <div className="row gap-12 no-print" style={{ marginBottom: 20, alignItems: 'center' }}>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
        <div className="fw-700" style={{ fontSize: 15, minWidth: 100, textAlign: 'center' }}>{monthLabel(month)}</div>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
        {/* 마감일이 있는 회사는 '8월분'이 7/26~8/25 다 — 구간을 적어야 대조할 수 있다 */}
        <span className="text-sm text-muted">집계 구간 {d.range.from} ~ {d.range.to}</span>
        {/* 내려받기는 위 '엑셀' 버튼 하나로 모았다(registerExport) */}
        {busy && <span className="text-sm text-muted ml-auto">엑셀을 만드는 중…</span>}
      </div>

      <KpiRow cols={4} style={{ marginBottom: 20 }}>
        <Kpi label="들어온 돈" value={S.all.actualIn} tone="pos" hint="이 구간에 입금 완료된 돈"/>
        <Kpi label="들어올 돈" value={S.all.planIn} hint="미수금·정기청구 등 예정"/>
        <Kpi label="나갈 돈"   value={S.all.plan} tone="neg" hint="이 구간에 남은 지출 예정"/>
        <Kpi label="현금 과부족" value={S.all.shortfall} tone={S.all.shortfall < 0 ? 'neg' : 'pos'}
          hint="지금 잔액 − 나갈 돈"/>
      </KpiRow>

      <FundSheetAccounts title="법인 계좌" g={d.corp}/>
      <FundSheetAccounts title="대표 개인 계좌" g={d.personal}/>

      {/* 요약 — 원본 엑셀의 '구분 / 보통계좌 / 저축 / 부채 …' 표 */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        <div className="card-pad fw-700" style={{ paddingBottom: 10 }}>요약</div>
        <div className="table-scroll" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>구분</th>
                <th className="num-right">보통계좌</th>
                <th className="num-right">저축·보증금</th>
                <th className="num-right">부채</th>
                <th className="num-right">나갈 돈</th>
                <th className="num-right">미지급 인건비</th>
                <th className="num-right">현금 과부족</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="fw-600">법인</td>
                <td className="num-cell num-right">{fsNum(S.corp.cash)}</td>
                <td/><td/>
                <td className="num-cell num-right">{fmtNum(S.corp.plan)}</td>
                <td/>
                <td className="num-cell num-right fw-700">{fsNum(S.corp.shortfall)}</td>
              </tr>
              <tr>
                <td className="fw-600">개인</td>
                <td className="num-cell num-right">{fsNum(S.personal.cash)}</td>
                <td/><td/>
                <td className="num-cell num-right">{fmtNum(S.personal.plan)}</td>
                <td/>
                <td className="num-cell num-right fw-700">{fsNum(S.personal.shortfall)}</td>
              </tr>
              <tr style={{ background: 'var(--surface-2)' }}>
                <td className="fw-700">합계</td>
                <td className="num-cell num-right fw-700">{fsNum(S.all.cash)}</td>
                <td className="num-cell num-right">{fmtNum(S.all.savings)}</td>
                <td className="num-cell num-right">{fmtNum(S.all.debt)}</td>
                <td className="num-cell num-right fw-700">{fmtNum(S.all.plan)}</td>
                <td className="num-cell num-right">{fmtNum(S.all.labor)}</td>
                <td className="num-cell num-right fw-700">{fsNum(S.all.shortfall)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {/* 부채·저축은 법인/개인으로 못 가른다 — 그 구분이 데이터에 없다. 지어내지 않는다. */}
        <div className="card-pad text-xs text-muted" style={{ paddingTop: 0 }}>
          저축·부채는 법인/개인 구분이 데이터에 없어 합계로만 냅니다.
        </div>
      </div>

      {/* 들어올 돈 — 원본의 <입금 예정금액> */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        <div className="row card-pad" style={{ paddingBottom: 10, alignItems: 'baseline' }}>
          <div className="fw-700">들어올 돈</div>
          <div className="ml-auto num fw-700">{fmtNum(d.incoming.reduce((s, x) => s + x.amount, 0))}원</div>
        </div>
        <table className="table">
          <thead><tr><th style={{ width: 130 }}>일자</th><th style={{ width: 110 }}>출처</th><th>내용</th><th>입금 계좌</th><th className="num-right" style={{ width: 140 }}>금액</th></tr></thead>
          <tbody>
            {d.incoming.map((it, i) => (
              <tr key={`${it.label}-${it.date}-${i}`}>
                <td className="num text-sm">
                  {it.noDue ? <span className="text-muted2">기한 미정</span> : it.date}
                  {it.overdue && <span className="badge warn" style={{ marginLeft: 6, fontSize: 10 }}>기한 지남</span>}
                </td>
                <td><span className="badge" style={{ fontSize: 10 }}>{it.source}</span></td>
                <td className="text-sm">{it.label}</td>
                <td className="text-sm text-muted">{it.account || '통장 미정'}</td>
                <td className="num-cell num-right fw-600">{fmtNum(it.amount)}</td>
              </tr>
            ))}
            {d.incoming.length === 0 && (
              <tr><td colSpan={5} className="text-muted text-sm" style={{ textAlign: 'center', padding: 20 }}>
                이 구간에 들어올 돈이 없어요.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 미지급 인건비 — 원본의 <퇴직자 미지급분> · <현직원 미지급 급여> */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        <div className="row card-pad" style={{ paddingBottom: 10, alignItems: 'baseline' }}>
          <div className="fw-700">미지급 인건비</div>
          <div className="ml-auto num fw-700">{fmtNum(d.labor.total)}원</div>
        </div>
        {d.labor.items?.length ? (
          <table className="table">
            <thead><tr><th style={{ width: 90 }}>구분</th><th>이름</th><th style={{ width: 90 }}>항목</th><th style={{ width: 110 }}>월분</th><th className="num-right" style={{ width: 140 }}>금액</th></tr></thead>
            <tbody>
              {d.labor.items.map((it, i) => (
                <tr key={`${it.name}-${it.kind}-${it.period || ''}-${i}`}>
                  <td className="text-sm">{it.status === 'retired' ? '퇴직자' : '현직원'}</td>
                  <td className="fw-600 text-sm">{it.name}</td>
                  <td className="text-sm">{it.kind === 'severance' ? '퇴직금' : '급여'}</td>
                  <td className="num text-sm text-muted">{it.period || ''}</td>
                  <td className="num-cell num-right">{fmtNum(it.remain)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-pad text-sm text-muted" style={{ paddingTop: 0 }}>
            이름별 명세는 인사 권한이 있어야 보여요. 합계는 위에 있습니다.
          </div>
        )}
      </div>

      <div className="text-xs text-muted" style={{ lineHeight: 1.7 }}>
        · <b>들어온 돈 / 나간 돈</b>은 원본 엑셀에 없던 항목입니다 — 이 구간에 실제로 입·출금이 끝난 금액입니다.<br/>
        · <b>차액</b>은 지금 잔액에서 나갈 돈을 뺀 값입니다(들어올 돈은 안 셉니다 — 원본과 같은 기준).<br/>
        · 카드 계좌는 계좌표에서 빼고, 결제일에 <b>카드 결제</b>로 한 번만 셉니다.<br/>
        · 나갈 항목은 금액 큰 순 {FS_TOP}개만 펼쳐 보여줍니다 — '외 N건'을 누르면 전부 보이고, 엑셀에는 모두 들어갑니다.
      </div>
    </div>
  )
}

/* ── 차입금 현황 ─────────────────────────────────────────────────
 *
 * 재무관리 > 차입금 화면에는 출력이 없어서, 대표·세무사에게 넘길 때마다 화면을 보고
 * 손으로 옮겨 적어야 했다. 여기 두면 보고서 껍데기가 주는 인쇄(→PDF)와
 * 표 CSV 내보내기를 그대로 얻는다.
 *
 * 그 위에 **서식 있는 엑셀**을 따로 둔다(lib/loanWorkbook.js) — CSV는 표 하나뿐이라
 * 요약·목록·상환내역을 한 파일로 넘길 수 없고, 금액에 자릿점도 안 붙는다.
 *
 * 상환 내역은 **계좌(차입금 건)별로 묶는다.** 날짜순 한 줄로 내면 여섯 계좌의 회차가
 * 뒤섞여 "이 계좌에 얼마 갚았나"를 눈으로 골라내야 한다. 차입금 이름에 계좌번호가
 * 붙어 있는 것("경남은행 64 (23.1218~28.1218)-9304")도 실무가 계좌 단위라는 뜻이다.
 *
 * 숫자는 전부 서버(lib/loanReport.js)가 낸다. 화면에서 다시 더하지 않는다 —
 * 그러면 화면 합계와 엑셀 합계가 어긋날 수 있다. */
const ReportLoan = ({ toast, registerExport }) => {
  const [status, setStatus] = useState('active')
  /* 고른 계좌들. **빈 배열 = 전체**다.
     칩은 기본이 '전부 선택'인데, 그 상태를 id 열넷을 담아 표현하면 계좌가 하나 늘 때마다
     "새 계좌는 왜 안 골라져 있지"가 된다. '아무것도 안 골랐다 = 전부'로 두면 늘 최신이다. */
  const [picks, setPicks] = useState([])
  const [range, setRange] = useState({ from: '', to: '' })   // 상환 내역 구간(빈 값 = 전 기간)
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)
  // 계좌 선택 목록은 **전체 기준**으로 따로 받는다. 고른 응답에는 고른 것만 들어 있어,
  // 같은 데이터로 목록을 만들면 고른 순간 칩이 사라져 되돌아올 수 없다.
  const [choices, setChoices] = useState([])

  useEffect(() => {
    let alive = true
    api.getLoanReport({ status }).then(x => { if (alive && x) setChoices(x.loans || []) })
    return () => { alive = false }
  }, [status])

  useEffect(() => {
    let alive = true
    setD(null)
    api.getLoanReport({ status, loanIds: picks, from: range.from, to: range.to })
      .then(x => { if (alive) setD(x) })
    return () => { alive = false }
  }, [status, picks, range.from, range.to])

  const download = async () => {
    setBusy(true)
    const r = await api.downloadLoanReportXlsx({ status, loanIds: picks, from: range.from, to: range.to })
    setBusy(false)
    if (!r.ok) toast.push(r.error || '내려받기에 실패했어요', { tone: 'warn' })
    else toast.push(picks.length ? `고른 ${picks.length}개 계좌를 내려받았어요` : '전체 계좌를 내려받았어요')
  }

  /* 껍데기의 '엑셀' 버튼이 이 함수를 쓰게 넘긴다.
     예전엔 껍데기의 '엑셀'(화면 표를 CSV로)과 이 화면의 '전체 엑셀로 내려받기'가
     나란히 서 있었다. 둘 다 '엑셀'이라 부르는데 나오는 파일이 달라서,
     어느 걸 눌러야 하는지 매번 갈렸다. 제대로 만든 쪽 하나로 모은다. */
  useEffect(() => {
    registerExport?.(download)
    return () => registerExport?.(null)
  }, [registerExport, status, picks, range.from, range.to])

  const toggle = (id) => setPicks(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  const picked = picks.length === 1 ? choices.find(l => l.id === picks[0]) : null

  const controls = (
    <div className="col gap-10 no-print" style={{ marginBottom: 20 }}>
      <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {/* 범위는 값이 둘뿐이라 칩 */}
        {[['active', '진행 중'], ['all', '상환 완료 포함']].map(([v, l]) => (
          <button key={v} type="button" className={`chip ${status === v ? 'active' : ''}`}
            onClick={() => { setStatus(v); setPicks([]) }}>{l}</button>
        ))}
        <span className="text-muted2" style={{ margin: '0 4px' }}>·</span>
        {/* 상환 내역 구간. 차입금 목록은 안 잘린다는 것을 아래 문구로 못 박는다 */}
        <span className="text-xs text-muted2">상환 내역 기간</span>
        <DateInput className="input" style={{ width: 140 }} value={range.from}
          onChange={e => setRange(r => ({ ...r, from: e.target.value }))}/>
        <span className="text-muted2">~</span>
        <DateInput className="input" style={{ width: 140 }} value={range.to}
          onChange={e => setRange(r => ({ ...r, to: e.target.value }))}/>
        {(range.from || range.to) && (
          <button className="btn sm" onClick={() => setRange({ from: '', to: '' })}>기간 해제</button>
        )}
      </div>

      {/* 계좌 — 칩 다중 선택. 아무것도 안 고르면 전체다(그 상태를 '전체' 칩으로 보여준다) */}
      {choices.length > 0 && (
        <div className="row gap-6" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className={`chip ${picks.length === 0 ? 'active' : ''}`}
            onClick={() => setPicks([])}>전체 {choices.length}건</button>
          {choices.map(l => (
            <button key={l.id} type="button"
              className={`chip ${picks.includes(l.id) ? 'active' : ''}`}
              onClick={() => toggle(l.id)} title={l.lender}>{l.name}</button>
          ))}
        </div>
      )}

      <div className="text-xs text-muted2">
        기간은 <b>상환 내역만</b> 자릅니다 — 그 기간에 상환이 없어도 차입금과 잔액은 그대로 나와요.
        내려받기는 위 <b>엑셀</b> 버튼을 쓰세요.
      </div>
    </div>
  )

  if (!d) return <div>{controls}<Loading label="차입금을 불러오는 중…"/></div>

  const T = d.totals
  if (!d.loans.length) {
    return (
      <div>
        {controls}
        <div className="text-sm text-muted2" style={{ padding: 24, textAlign: 'center' }}>
          {status === 'active' ? '진행 중인 차입금이 없어요.' : '등록된 차입금이 없어요.'}
        </div>
      </div>
    )
  }

  return (
    <div>
      {controls}
      {/* 한 계좌만 볼 때는 무엇을 보고 있는지 인쇄물에도 남아야 한다 */}
      {picked && (
        <div className="text-sm text-muted" style={{ marginBottom: 12 }}>
          <b>{picked.name}</b> · {picked.lender}
          {picked.accountName ? ` · 상환계좌 ${picked.accountName}` : ''}
        </div>
      )}

      <KpiRow cols={4} style={{ marginBottom: 24 }}>
        <Kpi label="차입원금" value={T.principal} badge={`${T.count}건`}/>
        <Kpi label="상환한 원금" value={T.repaidPrincipal} tone="pos"/>
        <Kpi label="남은 원금" value={T.remaining} tone="neg" hint="차입원금 − 상환원금"/>
        <Kpi label="지급한 이자" value={T.repaidInterest} hint="이미 나간 비용 — 남은 원금에 안 더해요"/>
      </KpiRow>

      {/* 1. 차입처별 — **두 건 이상일 때만** 뜻이 있다. 한 건이면 한 줄짜리 표라
             아래 목록과 같은 말을 두 번 하는 셈이다(칩 다중 선택이 되면서 '전체냐 아니냐'가
             아니라 '몇 건이 보이느냐'가 기준이 됐다). */}
      {d.loans.length > 1 && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
          <div className="card-pad fw-700" style={{ paddingBottom: 10 }}>차입처별 요약</div>
          <table className="table">
            <thead>
              <tr>
                <th>차입처</th>
                <th style={{ width: 70 }} className="num-right">건수</th>
                <th className="num-right">차입원금</th>
                <th className="num-right">상환원금</th>
                <th className="num-right">남은원금</th>
                <th className="num-right">지급이자</th>
              </tr>
            </thead>
            <tbody>
              {d.byLender.map(g => (
                <tr key={g.lender}>
                  <td className="fw-700">{g.lender}</td>
                  <td className="num-cell num-right">{g.count}</td>
                  <td className="num-cell num-right">{fmtNum(g.principal)}</td>
                  <td className="num-cell num-right" style={{ color: 'var(--pos)' }}>
                    {g.repaidPrincipal ? fmtNum(g.repaidPrincipal) : '—'}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(g.remaining)}</td>
                  <td className="num-cell num-right text-muted">
                    {g.repaidInterest ? fmtNum(g.repaidInterest) : '—'}</td>
                </tr>
              ))}
              <tr>
                <td className="fw-700">합계</td>
                <td className="num-cell num-right fw-700">{T.count}</td>
                <td className="num-cell num-right fw-700">{fmtNum(T.principal)}</td>
                <td className="num-cell num-right fw-700">{fmtNum(T.repaidPrincipal)}</td>
                <td className="num-cell num-right fw-700">{fmtNum(T.remaining)}</td>
                <td className="num-cell num-right fw-700">{fmtNum(T.repaidInterest)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* 2. 계좌별 현황 */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        <div className="card-pad fw-700" style={{ paddingBottom: 10 }}>계좌별 현황</div>
        <table className="table">
          <thead>
            <tr>
              <th>차입처</th><th>차입금명(계좌)</th><th>차입일</th>
              <th className="num-right">차입원금</th>
              <th className="num-right">상환원금</th>
              <th className="num-right">남은원금</th>
              <th style={{ width: 80 }} className="num-right">연이율</th>
              <th style={{ width: 90 }}>상환방식</th>
              <th>상환계좌</th>
            </tr>
          </thead>
          <tbody>
            {d.loans.map(l => (
              <tr key={l.id}>
                <td className="text-sm">{l.lender}</td>
                <td className="fw-700">{l.name}</td>
                <td className="text-sm num">{l.startDate}</td>
                <td className="num-cell num-right">{fmtNum(l.principal)}</td>
                <td className="num-cell num-right" style={{ color: 'var(--pos)' }}>
                  {l.repaidPrincipal ? fmtNum(l.repaidPrincipal) : '—'}</td>
                <td className="num-cell num-right fw-700">{fmtNum(l.remaining)}</td>
                {/* 이율 0은 '0%'로 찍지 않는다 — 무이자로 읽힌다(임포트분은 아직 안 채웠다) */}
                <td className="num-cell num-right text-sm">
                  {l.annualRate ? `${l.annualRate}%` : <span className="text-muted2">—</span>}</td>
                <td className="text-sm text-muted">{LOAN_METHOD_LABEL[l.method] || l.method}</td>
                <td className="text-sm text-muted">{l.accountName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3. 계좌별 상환 내역 — 계좌마다 표 하나 + 소계 */}
      <div className="fw-700" style={{ margin: '24px 0 12px', fontSize: 15 }}>
        계좌별 상환 내역 <span className="text-sm text-muted fw-400">{d.repayments.length}건</span>
      </div>
      {(d.byLoan || []).map(g => (
        <div key={g.loanId} className="card" style={{ overflow: 'hidden', marginBottom: 14 }}>
          <div className="row card-pad" style={{ paddingBottom: 10, gap: 8, alignItems: 'baseline' }}>
            <span className="text-sm text-muted">{g.lender}</span>
            <span className="fw-700">{g.loanName}</span>
            <span className="text-sm text-muted ml-auto">
              남은원금 <b className="num">{fmtNum(g.remaining)}</b>원
            </span>
          </div>
          {g.rows.length === 0 ? (
            <div className="text-sm text-muted2" style={{ padding: '10px 18px 18px' }}>
              상환 처리한 회차가 없어요.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>납부일</th>
                  <th style={{ width: 60 }} className="num-right">회차</th>
                  <th>예정일</th>
                  <th className="num-right">원금</th>
                  <th className="num-right">이자</th>
                  <th className="num-right">합계</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map(r => (
                  <tr key={`${r.loanId}-${r.seq}`}>
                    <td className="text-sm num">{r.paidDate}</td>
                    <td className="num-cell num-right text-sm">{r.seq}</td>
                    <td className="text-sm num text-muted">{r.dueDate}</td>
                    {/* 이자만 낸 회차는 원금이 0이다. '0'으로 찍으면 0을 —로 두는 다른 열과 어긋난다 */}
                    <td className="num-cell num-right">{r.principal ? fmtNum(r.principal) : '—'}</td>
                    <td className="num-cell num-right text-muted">{r.interest ? fmtNum(r.interest) : '—'}</td>
                    <td className="num-cell num-right fw-700">{fmtNum(r.total)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="fw-700">소계</td>
                  <td className="num-cell num-right fw-700">{g.subtotal.count}</td>
                  <td/>
                  <td className="num-cell num-right fw-700">{fmtNum(g.subtotal.principal)}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(g.subtotal.interest)}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(g.subtotal.total)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      ))}

      <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
        · <b>남은원금 = 차입원금 − 상환원금</b>이에요. 지급한 이자는 이미 나간 비용이라
        남은원금에 더하지 않아요 — 더하면 "앞으로 갚을 돈"이 실제보다 커집니다.<br/>
        · 상환 내역은 <b>실제로 처리한 회차</b>만 담아요. 앞으로 나갈 상환 예정은 자금 현황에서 봅니다.<br/>
        · 엑셀은 지금 고른 그대로 나옵니다 — 계좌를 고르면 그 계좌만, 전체면 전체가 담겨요.
      </div>
    </div>
  )
}

/* 카드 사용내역 — 카드별로 **쓴 돈과 갚은 돈**을 한 장에.
 *
 * 데이터는 여태 다 있었다(카드 계좌에 달린 지출이 곧 사용 기록이다). 없던 것은 **넘길 문서**다.
 * 감사·세무사가 "이 카드 이번 분기 내역 주세요" 하면 거래내역을 계좌로 걸러 화면을 보고
 * 손으로 옮겨 적었다. 차입금 현황을 여기 둔 이유와 같다.
 *
 * ⚠ '법인카드 사용 기록부'로 짓지 않는다. 중소기업은 **대표 개인 명의 카드로 회사 돈을 쓰는
 *   일이 흔하다**(그래서 accounts.owner 가 있다). 법인만 다루면 개인 명의 사용분은 여전히
 *   낼 문서가 없다. 전부 담고 소유로 거른다 — 법인만 뽑으면 그게 곧 법인카드 기록부다.
 *
 * ⚠ 쓴 돈 옆에 **갚은 돈**을 같이 놓는다. 사용액만 있으면 "그래서 통장에서 얼마 나갔나"를
 *   알 수 없다. 신용카드는 쓴 달과 나가는 달이 다르기 때문이다.
 *
 * 숫자는 전부 서버(lib/cardReport.js)가 낸다. 화면에서 다시 더하지 않는다. */
const ReportCard = ({ toast }) => {
  const [period, setPeriod] = useState(() => periodToRange('month'))
  const [owner, setOwner] = useState('all')
  const [cardType, setCardType] = useState('all')
  const [cardId, setCardId] = useState('')
  const [d, setD] = useState(null)
  // 카드 목록은 **한 장을 고르기 전 기준**으로 따로 받는다. 고른 응답으로 목록을 만들면
  // 고르는 순간 드롭다운에 그 카드만 남아 전체로 되돌아올 수 없다(차입금 보고서와 같은 함정).
  const [choices, setChoices] = useState([])

  const q = { from: period.from, to: period.to, owner, cardType }

  useEffect(() => {
    let alive = true
    api.getCardReport(q).then(x => { if (alive && x) setChoices(x.cards || []) })
    return () => { alive = false }
  }, [period.from, period.to, owner, cardType])

  useEffect(() => {
    let alive = true
    setD(null)
    api.getCardReport({ ...q, cardId }).then(x => { if (alive) setD(x) })
    return () => { alive = false }
  }, [period.from, period.to, owner, cardType, cardId])

  // 고른 카드가 필터 밖으로 나가면(소유·종류를 바꿨을 때) 손에 든 선택을 놓는다.
  useEffect(() => {
    if (cardId && choices.length && !choices.some(c => c.id === cardId)) setCardId('')
  }, [choices, cardId])

  const controls = (
    <div className="no-print">
      <PeriodFilter value={period} onChange={setPeriod}/>
      <div className="row gap-8" style={{ marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* 값이 셋뿐이라 칩. 카드는 회사마다 열 장 넘게 있어 Combobox */}
        <span className="text-sm text-muted fw-600">소유</span>
        {[['all', '전체'], ['corp', '법인'], ['personal', '대표 개인']].map(([v, l]) => (
          <button key={v} type="button" className={`chip ${owner === v ? 'active' : ''}`}
            onClick={() => setOwner(v)}>{l}</button>
        ))}
        <span className="chip-div"/>
        <span className="text-sm text-muted fw-600">종류</span>
        {[['all', '전체'], ['credit', '신용'], ['check', '체크']].map(([v, l]) => (
          <button key={v} type="button" className={`chip ${cardType === v ? 'active' : ''}`}
            onClick={() => setCardType(v)}>{l}</button>
        ))}
        <div style={{ width: 260 }}>
          <Combobox value={cardId} onChange={setCardId} allowAdd={false}
            options={[{ value: '', label: '전체 카드', sub: `${choices.length}장` },
              ...choices.map(c => ({ value: c.id, label: c.name, sub: `${c.owner_label} · ${c.type_label}` }))]}
            placeholder="카드 선택"/>
        </div>
      </div>
    </div>
  )

  if (!d) return <div>{controls}<Loading label="카드 내역을 불러오는 중…"/></div>

  const T = d.totals
  if (!d.cards.length) {
    return (
      <div>
        {controls}
        <div className="text-sm text-muted2" style={{ padding: 24, textAlign: 'center' }}>
          {owner === 'all' && cardType === 'all'
            ? '등록된 카드가 없어요. 기준정보 › 계좌·카드에서 먼저 등록해주세요.'
            : '조건에 맞는 카드가 없어요.'}
        </div>
      </div>
    )
  }

  return (
    <div>
      {controls}
      <PeriodNote period={period}/>
      {/* 무엇으로 걸러 본 것인지 인쇄물에도 남아야 한다 — 안 적히면 나중에 근거가 못 된다 */}
      {(owner !== 'all' || cardType !== 'all') && (
        <div className="text-sm text-muted" style={{ marginBottom: 12 }}>
          범위: {owner === 'corp' ? '법인 명의' : owner === 'personal' ? '대표 개인 명의' : '전체 소유'}
          {cardType !== 'all' ? ` · ${cardType === 'check' ? '체크카드' : '신용카드'}` : ''}
        </div>
      )}

      <KpiRow cols={T.no_evidence ? 4 : 3} style={{ marginBottom: 24 }}>
        <Kpi label="사용액" value={T.used} badge={`${T.count}건`}/>
        <Kpi label="카드대금 결제" value={T.paid} tone="pos" hint="이 기간에 통장에서 카드로 나간 돈"/>
        <Kpi label="카드" value={d.cards.length} unit="장"/>
        {/* 증빙 미첨부는 **있을 때만** 낸다. 0건을 세워 두면 정상에 표식을 다는 꼴이다 */}
        {!!T.no_evidence && <Kpi label="증빙 미첨부" value={T.no_evidence} unit="건" tone="neg"/>}
      </KpiRow>

      {/* 1. 카드별 요약 — 한 장만 볼 때는 한 줄짜리 표가 되니 그리지 않는다 */}
      {!cardId && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
          <div className="card-pad fw-700" style={{ paddingBottom: 10 }}>카드별 요약</div>
          <table className="table">
            <thead>
              <tr>
                <th>카드</th><th style={{ width: 80 }}>소유</th><th style={{ width: 70 }}>종류</th>
                <th style={{ width: 70 }} className="num-right">건수</th>
                <th className="num-right">사용액</th>
                <th className="num-right">결제액</th>
                <th style={{ width: 80 }}>결제일</th>
                <th>결제계좌</th>
              </tr>
            </thead>
            <tbody>
              {d.cards.map(c => (
                <tr key={c.id}>
                  <td className="fw-700">{c.name}</td>
                  <td className="text-sm text-muted">{c.owner_label}</td>
                  <td className="text-sm text-muted">{c.type_label}</td>
                  <td className="num-cell num-right">{c.count || '—'}</td>
                  <td className="num-cell num-right fw-700">{c.used_total ? fmtNum(c.used_total) : '—'}</td>
                  <td className="num-cell num-right" style={{ color: c.paid_total ? 'var(--pos)' : undefined }}>
                    {c.paid_total ? fmtNum(c.paid_total) : '—'}</td>
                  {/* 체크카드는 결제일이 없다 — 쓴 즉시 통장에서 빠진다 */}
                  <td className="text-sm text-muted num">{c.pay_day ? `${c.pay_day}일` : '—'}</td>
                  <td className="text-sm text-muted">{c.pay_account || '—'}</td>
                </tr>
              ))}
              <tr>
                <td className="fw-700">합계</td><td/><td/>
                <td className="num-cell num-right fw-700">{T.count}</td>
                <td className="num-cell num-right fw-700">{fmtNum(T.used)}</td>
                <td className="num-cell num-right fw-700">{fmtNum(T.paid)}</td>
                <td/><td/>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* 2. 카드별 사용 내역 */}
      <div className="fw-700" style={{ margin: '24px 0 12px', fontSize: 15 }}>
        카드별 사용 내역 <span className="text-sm text-muted fw-400">{T.count}건</span>
      </div>
      {d.cards.map(c => (
        <div key={c.id} className="card" style={{ overflow: 'hidden', marginBottom: 14 }}>
          <div className="row card-pad" style={{ paddingBottom: 10, gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="fw-700">{c.name}</span>
            <span className="text-sm text-muted">{c.owner_label} · {c.type_label}</span>
            {c.number && <span className="text-sm text-muted2 num">{c.number}</span>}
            <span className="text-sm text-muted ml-auto">
              사용 <b className="num">{fmtNum(c.used_total)}</b>원
              {c.paid_total ? <> · 결제 <b className="num">{fmtNum(c.paid_total)}</b>원</> : null}
            </span>
          </div>

          {c.lines.length === 0 ? (
            <div className="text-sm text-muted2" style={{ padding: '10px 18px 18px' }}>
              이 기간에 사용 내역이 없어요.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>날짜</th>
                  <th>거래처</th>
                  <th style={{ width: 140 }}>비목</th>
                  <th>내용</th>
                  <th style={{ width: 110 }}>증빙</th>
                  <th className="num-right" style={{ width: 130 }}>금액</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map(l => (
                  <tr key={l.id}>
                    <td className="text-sm num">{l.date}</td>
                    <td className="text-sm">{l.vendor || '—'}</td>
                    <td className="text-sm text-muted">{l.category || '—'}</td>
                    <td className="text-sm text-muted">{l.memo || '—'}</td>
                    {/* 챙긴 건에는 표식을 달지 않는다 — 눈에 띄어야 하는 건 빠진 쪽이다 */}
                    <td className="text-sm">
                      {l.evidence ? <span className="text-muted2">—</span>
                        : <span style={{ color: 'var(--neg-ink)' }}>미첨부</span>}
                    </td>
                    <td className="num-cell num-right fw-700">{fmtNum(l.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="fw-700">소계</td><td/><td/><td/>
                  {/* 미첨부 건수는 한 줄로 — 감기면 소계 줄만 키가 커져 표가 들쭉날쭉해진다 */}
                  <td className="num-cell num-right text-muted" style={{ whiteSpace: 'nowrap' }}>
                    {c.no_evidence ? `미첨부 ${c.no_evidence}건` : ''}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(c.used_total)}</td>
                </tr>
              </tbody>
            </table>
          )}

          {/* 3. 그 기간의 카드대금 결제 — 없으면 구획을 아예 그리지 않는다 */}
          {c.payments.length > 0 && (
            <>
              <div className="card-pad text-sm fw-700" style={{ paddingTop: 14, paddingBottom: 8 }}>
                카드대금 결제
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>결제일</th>
                    <th>출금 계좌</th>
                    <th>내용</th>
                    <th className="num-right" style={{ width: 130 }}>결제액</th>
                  </tr>
                </thead>
                <tbody>
                  {c.payments.map(p => (
                    <tr key={p.id}>
                      <td className="text-sm num">{p.date}</td>
                      <td className="text-sm">{p.from || '—'}</td>
                      <td className="text-sm text-muted">{p.memo || '—'}</td>
                      <td className="num-cell num-right" style={{ color: 'var(--pos)' }}>{fmtNum(p.amount)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="fw-700">소계</td><td/><td/>
                    <td className="num-cell num-right fw-700">{fmtNum(c.paid_total)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      ))}

      <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
        · <b>사용액과 결제액은 서로 맞지 않는 것이 정상</b>이에요. 신용카드는 쓴 달과
        통장에서 나가는 달이 다릅니다. 체크카드는 쓸 때 바로 빠져서 결제 줄이 없어요.<br/>
        · 소유를 <b>법인</b>으로 두고 인쇄하면 그것이 법인카드 사용 기록부예요.<br/>
        · 카드대금 결제는 <b>입출금 › 출금 › 카드 대금 지급</b>으로 기록한 것만 담겨요.
      </div>
    </div>
  )
}

/** 상환방식 표기 — 서버 lib/loanReport.js 의 METHOD_LABEL 과 같은 말을 써야 한다 */
const LOAN_METHOD_LABEL = {
  equal_payment: '원리금균등', equal_principal: '원금균등',
  bullet: '만기일시', none: '일정 없음',
}

const REPORT_VIEWS = {
  monthly: ReportMonthly, tax4: ReportTax4, contract: ReportContract,
  category: ReportCategory, vendor: ReportVendor, ar: ReportAR,
  subcontract: ReportSubcontract, defense: ReportDefense,
  taxoffice: ReportTaxOffice, vat: ReportVAT, fundsheet: ReportFundSheet,
  loan: ReportLoan, card: ReportCard,
}

/* 분류를 세우는 순서 — 카탈로그가 주는 이름을 이 순서대로 놓는다.
   축은 '누가 보는가'다: 대표가 여는 것 → 경리가 매일 쓰는 것 → 밖으로 나가는 것.
   목록에 없는 이름은 마지막에 '기타'로 붙는다(카탈로그가 늘어도 화면이 안 깨진다). */
const GROUP_ORDER = ['경영 보고', '장부', '신고·제출', '기타']

/* 분류마다 아이콘을 정한다. 예전엔 '화면이 따로 있나'(route 유무)로 아이콘을 갈랐는데,
   그건 **구현 사정**이지 보는 사람에게는 아무 뜻이 없다 — 같은 '장부' 안에서 카드 사용내역만
   다른 아이콘이 되는 식이었다. 타일을 훑을 때 아이콘이 먼저 눈에 들어오므로,
   아이콘은 '이게 어떤 성격의 자료인가'를 말해야 한다. */
const GROUP_ICON = {
  '경영 보고': Icon.Trend,   // 흐름·추세를 보는 것 — 대표가 여는 자리
  '장부': Icon.Book,         // 매일 적고 뽑는 것 — 경리의 자리
  '신고·제출': Icon.Sign,    // 밖으로 나가는 서류
  '기타': Icon.Chart,
}

export const ReportsScreen = ({ go }) => {
  const { can: canDo } = usePerms()
  const toast = useToast()
  const [active, setActive] = useState(null)
  const [items, setItems] = useState(null)     // null = 아직 안 불러옴
  const printRef = useRef(null)

  useEffect(() => {
    let alive = true
    api.getReports().then(list => { if (alive) setItems(list) })
    return () => { alive = false }
  }, [])

  /* 화면이 있는 것만 그린다 — 서버가 먼저 배포돼 아직 없는 key 를 줘도 깨지지 않는다.
     ⚠ route 를 가진 항목은 **화면이 따로 있으므로**(일계표·전표 목록 등) 여기서 빼면 안 된다.
       REPORT_VIEWS 만 보고 거르면 흡수한 여섯이 통째로 사라진다. */
  const list = (items || []).filter(r => r.route || REPORT_VIEWS[r.key])
  /* 서버는 '이 회사가 살 수 있고 켜 둔 것'만 준다 — 그건 회사 축이다.
     route 항목은 **사람 축**(권한)도 있다. 그 화면을 못 보는 사람에게 타일을 세우면
     눌러서 403 을 보게 된다. 잎 id 가 곧 권한 자원이라 그대로 물어보면 된다. */
  const visibleList = list.filter(r => !r.route || canDo(r.route))
  const report = list.find(r => r.key === active)
  /* 보고서가 스스로 등록한 내려받기 함수. ref 인 이유 — 등록 때문에 껍데기가 다시 그려지면
     그 보고서도 다시 그려지고, 그 안의 effect 가 또 등록해 끝없이 돈다. */
  const customExport = useRef(null)
  /* 등록도 해제도 **보고서 쪽 effect 한 곳**에서만 한다.
     껍데기가 active 를 보고 지우면, effect 는 자식→부모 순이라 자식이 등록한 **뒤에** 지워진다.
     그러면 등록이 통째로 날아가 화면 표 CSV 가 대신 나온다(지금은 우연히 살아 있을 뿐이다).
     보고서를 바꾸면 앞 보고서가 언마운트되며 스스로 null 을 넣으므로 남는 등록도 없다.
     함수 정체를 고정(useCallback)하는 이유 — 매 렌더 새 함수면 자식 effect 가 계속 다시 돈다. */
  const registerExport = useCallback((fn) => { customExport.current = fn }, [])

  /* 예전엔 두 버튼이 토스트만 띄웠다("PDF로 내려받았어요"). 파일은 안 받아지는데 받았다고 말하니
     세무 신고철에 자료를 챙겼다고 믿고 넘어갈 수 있었다. 둘 다 실제로 동작하게 바꾼다.
     · 인쇄 — PDF 생성기를 새로 들이지 않고 브라우저 인쇄를 쓴다(앱의 기존 방식). 인쇄 대화상자에서
       'PDF로 저장'을 고르면 PDF가 된다. 그래서 버튼 이름도 실제 동작인 '인쇄'로 적는다.
     · 엑셀 — 화면에 그려진 표를 그대로 CSV로 뽑는다(lib/export.js). 보고서마다 집계를 다시 짜지
       않으므로 보이는 것과 받는 것이 어긋날 수 없다. */
  /* 보고서가 **제대로 만든 엑셀**을 갖고 있으면 그것을 쓴다(registerExport 로 등록).
     없으면 화면 표를 CSV 로 뽑는 기본 동작.
     예전엔 이 버튼(CSV)과 보고서 안의 전용 엑셀 버튼이 나란히 서 있었다 —
     둘 다 '엑셀'인데 나오는 파일이 달라 어느 걸 눌러야 하는지 매번 갈렸다. */
  const doExport = () => {
    if (customExport.current) return customExport.current()
    const ok = downloadVisibleTables(printRef.current, `${report.title}_${localToday()}.csv`)
    if (!ok) toast.push("내보낼 표가 없어요", { tone: 'warn' })
  }

  if (active && report) {
    const View = REPORT_VIEWS[active]
    return (
      <div className="fade-up">
        <div className="row no-print" style={{ paddingTop: 30, marginBottom: 20 }}>
          <button className="btn" onClick={() => setActive(null)}><Icon.Left size={14}/> 보고서 목록</button>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => window.print()}><Icon.Print size={14}/> 인쇄</button>
            <button className="btn excel" onClick={doExport}><Icon.Excel size={14}/> 엑셀</button>
          </div>
        </div>
        {/* report-print — index.css 의 인쇄 whitelist. 이 클래스가 없으면 인쇄가 백지로 나온다. */}
        <div className="report-print" ref={printRef}>
          <div className="page-title" style={{ marginBottom: 4 }}>{report.title}</div>
          <div className="page-sub" style={{ marginBottom: 24 }}>{localToday()} 조회 기준</div>
          <View toast={toast} registerExport={registerExport}/>
        </div>
      </div>
    )
  }

  return (
    <div className="fade-up">
      <PageHeader title="보고서"/>
      {items === null ? (
        <Loading label="보고서 목록을 불러오는 중…"/>
      ) : list.length === 0 ? (
        <div className="card card-pad text-sm text-muted" style={{ textAlign: "center", padding: 40 }}>
          볼 수 있는 보고서가 없어요. 관리자에게 문의하세요.
        </div>
      ) : (
        /* 기준정보·환경설정과 **같은 부품**을 쓴다(TileBoard). 즐겨찾기·정렬이 붙는다.
         *
         * ⓷ 카탈로그가 분류(group)를 주므로 여기 groups 가 여럿이 되고 분류 탭이 저절로 선다.
         *   축은 **'누가 보는가'** 다 — 대표가 여는 '경영 보고'와 경리가 매일 쓰는 '장부'를
         *   평평하게 두면 대표 자리의 뜻이 옅어진다.
         *
         * ⚠ route 가 있는 항목은 **화면이 따로 있다**(일계표·전표 목록 등). 여기서 그리지
         *   않고 그 라우트로 보낸다 — 화면을 REPORT_VIEWS 로 옮기면 잎 id 가 끊기고,
         *   그 id 는 권한 자원이자 주소·검색·바로가기의 이름이다. */
        <TileBoard
          storageKey="report"
          groups={GROUP_ORDER
            .map(label => ({ label, items: visibleList.filter(r => (r.group || '기타') === label) }))
            .filter(g => g.items.length > 0)
            .map(g => ({
              label: g.label,
              items: g.items.map(r => ({
                id: r.key, title: r.title, desc: r.descr,
                icon: GROUP_ICON[g.label] || GROUP_ICON['기타'],
              })),
            }))}
          onPick={(key) => {
            const item = list.find(r => r.key === key)
            if (item?.route) return go ? go(item.route) : undefined
            setActive(key)
          }}
          empty="볼 수 있는 보고서가 없어요. 관리자에게 문의하세요."/>
      )}
    </div>
  )
}
