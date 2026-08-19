import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Combobox, Drawer, localToday, DateInput } from '../ui'
import { DrawerHead } from './Drawer'
import { Kpi, KpiRow } from './Kpi'
import { api } from '../api'

// 월 표기(2026-07 → 2026년 7월). HR.jsx 와 같은 규칙 — 여기서 쓰려고 함께 옮긴다.
const monthLabel = (m) => { const [y, mo] = (m || '').split('-'); return y ? `${y}년 ${Number(mo)}월` : m }

/**
 * 급여·용역 지급 등록 Drawer — payroll 한 회차(id)에 실제 이체분을 기록한다.
 *
 * 원래 HR.jsx 안에만 있어서 **급여대장에서만** 지급을 등록할 수 있었다. 용역·일용은
 * 회차를 "명세 저장"으로만 만들어 두면 미지급으로 남는데, 그걸 지급 처리할 화면이 없어
 * 용역대장·계약 상세에 미지급 금액이 영영 남아 있었다(계좌에서도 나가지 않는다).
 * 두 곳이 같은 API(POST /payroll/:id/pay)를 쓰므로 컴포넌트를 여기로 올려 공유한다.
 *
 * row: { id, name, month, net_salary, paid, remain, payments? }
 */
/** label: 이 지급의 성격. 용역·일용은 '급여'가 아니다 — 용역계약 상세에서 열면 '용역비'로 부른다. */
export const PayrollPayDrawer = ({ row, accounts, onClose, onSaved, label = '급여' }) => {
  const toast = useToast();
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState("");
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState("계좌이체");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!row) return;
    setAmount(row.remain > 0 ? row.remain : 0);
    setDate(localToday());   // KST — 서버 futureDateError와 정렬
    // 출금 계좌는 필수다. 비우면 그 지출이 계좌 잔액에서 빠지지 않으므로 은행계좌를 기본 선택한다.
    setAccountId(accounts.find(a => a.kind === "bank")?.id || accounts[0]?.id || "");
    setMethod("계좌이체");
  }, [row, accounts]);

  if (!row) return null;
  const remain = row.remain;

  // 왕복 중 두 번 누르면 지출 거래가 두 건 생겨 **계좌에서 두 번 빠진다**.
  // 서버에 멱등키가 없어(회차 개념도 없다) 화면에서 막아야 한다.
  const register = async () => {
    if (busy) return;
    if (!amount || amount <= 0) return toast.push("지급액을 입력해주세요", { tone: 'warn' });
    if (!accountId) return toast.push("출금 계좌를 선택해주세요", { tone: 'warn' });
    setBusy(true);
    try {
      const res = await api.payPayroll(row.id, { amount, date, account_id: accountId, method });
      if (res.ok) { toast.push(`${label} 지급을 등록했어요 (거래내역에 반영)`); onSaved(); onClose(); }
      else toast.push(res.error || "등록에 실패했어요", { tone: 'warn' });
    } finally { setBusy(false); }
  };
  const removePay = async (txnId) => {
    const res = await api.deletePayrollPayment(row.id, txnId);
    if (res.ok) { toast.push("지급 내역을 취소했어요"); onSaved(); onClose(); }
    else toast.push("취소에 실패했어요", { tone: 'warn' });
  };

  return (
    <Drawer open={true} onClose={onClose} width="min(520px, 100vw)">
      <DrawerHead
        title={<>{row.name} {label} 지급 — {monthLabel(row.month)}</>}
        sub="실제 이체분을 등록하면 거래내역(지출)에 자동 기록돼요"
        onClose={onClose}/>

      <div className="drawer-body">
        {/* 뱃지 없이 색만 쓰는 자리 — 예전엔 tone 이 빈 뱃지를 칠했다(문구가 없어 빈 알약만 떴다). 이제 숫자 색으로 신호를 준다. */}
        <KpiRow cols={3} gap={10} style={{ marginBottom: 18 }}>
          <Kpi label="실수령" value={fmtNum(row.net_salary) + "원"}/>
          <Kpi label="지급 완료" value={fmtNum(row.paid) + "원"} tone="brand"/>
          <Kpi label={remain >= 0 ? "미지급" : "과지급"} value={fmtNum(Math.abs(remain)) + "원"} tone={remain > 0 ? "warn-ink" : remain < 0 ? "neg-ink" : undefined}/>
        </KpiRow>

        <div className="col gap-form">
          <div>
            <label className="label">이번 지급액 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <div style={{ position: "relative" }}>
              <input className="input num fw-700" style={{ paddingRight: 32 }} value={fmtNum(amount)}
                onChange={e => setAmount(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}/>
              <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 12 }}>원</span>
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label className="label">지급일</label>
              <DateInput className="input num" value={date} max={localToday()} onChange={e => setDate(e.target.value)}/>
            </div>
            <div>
              <label className="label">지급 수단</label>
              <div className="row gap-6">
                {["계좌이체", "현금"].map(m => (
                  <button key={m} type="button" className={`chip ${method === m ? "active" : ""}`} onClick={() => setMethod(m)}>{m}</button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="label">출금 계좌 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <Combobox value={accountId} onChange={setAccountId}
              options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.kind === "card" ? "카드" : a.bankName, a.number].filter(Boolean).join(" ") }))}
              placeholder="계좌 선택"/>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>이 계좌에서 나간 것으로 기록돼 잔액에 반영됩니다.</div>
          </div>
        </div>

        {(row.payments && row.payments.length > 0) && (
          <div style={{ marginTop: 24 }}>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>지급 내역 {row.payments.length}건</div>
            <div className="col gap-6">
              {row.payments.map(p => (
                <div key={p.id} className="row gap-8" style={{ padding: "8px 12px", background: "var(--surface-2)", borderRadius: 8 }}>
                  <span className="num text-sm text-muted">{p.date}</span>
                  <span className="num fw-700 ml-auto">{fmtNum(p.amount)}원</span>
                  <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => removePay(p.id)}>취소</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>닫기</button>
        <button className="btn primary ml-auto" onClick={register} disabled={busy}>
          <Icon.Bank size={14}/> {busy ? '처리 중…' : '지급 등록'}
        </button>
      </div>
    </Drawer>
  );
};
