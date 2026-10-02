import { useState } from 'react'
import { Icon, Combobox, useToast } from '../ui'
import { MAIN_BADGE } from '../mainAccount'
import { usePerms } from '../perms'
import { api } from '../api'

/**
 * 계좌·카드·현금 고르기 — **이름 · 은행(카드사) · 번호**를 칸으로 보여 주고, 없으면 그 자리에서 만든다.
 *
 * 왜 — 칩에 이름만 보여서 같은 이름의 카드 둘을 못 가렸고, 목록에 없으면 거래를 적다 말고
 *   기준정보로 나갔다 와야 했다(2026-09-30 사용자 실사용: 칼국수 법인카드 결제 한 건에 화면을 세 번 옮겼다).
 *
 *   ┌ [🔍 카드명·카드사·번호로 찾기 ▾]                [+ 새 카드]
 *   └ 카드명 [   ]   카드사 [   ]   카드번호 [   ]   ← 고르면 채워진다 / [+ 새 카드]면 입력칸
 *
 * - 번호가 같으면 **이미 있는 것**이다(이름이 달라도) — 새로 만들지 않고 그걸 고르게 한다(서버도 409)
 * - 새로 만들면 알린다(기준정보에 생긴다) · 등록 권한이 없으면 [+ 새 …] 대신 요청 안내
 * - 현금은 회사에 하나 — 칸 없이 고르고, 없으면 [현금 계정 만들기] 한 번
 * - ⚠ 미리 고르지 않는다(lib/mainAccount.js) — 주거래는 목록 앞에 세우고 표시만 한다
 *
 * @param kind      'bank' | 'card' | 'cash'
 * @param accounts  이 종류의 목록(보일 순서 그대로 — withMainFirst 는 부르는 쪽이)
 * @param allAccounts 중복 판정용 전체 목록(없으면 accounts)
 * @param value / valueKey  부르는 폼이 계좌를 무엇으로 드나('name' | 'id')
 * @param onChange(value, account)
 * @param onCreated(account) 새로 만든 뒤 — 부르는 쪽이 목록을 다시 읽는다
 */
const WORD = {
  bank: { what: '계좌', name: '계좌명', org: '은행', no: '계좌번호', res: 'master_account', ph: ['예: 기업은행 주거래', '예: IBK기업은행', '예: 000-000000-00-000'] },
  card: { what: '카드', name: '카드명', org: '카드사', no: '카드번호', res: 'master_card', ph: ['예: 법인카드(국민)', '예: 국민카드', '예: 0000-0000-0000-0000'] },
  // 통장·카드를 함께 고르는 자리(세금계산서 지급 처리 — 카드로 낼 수도 있다). 새로 만들 때는 통장으로 만든다
  any:  { what: '계좌', name: '이름', org: '은행·카드사', no: '번호', res: 'master_account', ph: ['예: 기업은행 주거래', '예: IBK기업은행', '예: 000-000000-00-000'] },
}
const digits = (s) => String(s || '').replace(/\D/g, '')

export const AccountField = ({ kind = 'bank', accounts = [], allAccounts, value, valueKey = 'id', onChange,
  onCreated, isMain = () => false, placeholder }) => {
  const toast = useToast()
  const { can } = usePerms()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', bank: '', number: '' })
  const [busy, setBusy] = useState(false)
  const all = allAccounts || accounts

  // ── 현금 — 하나뿐이라 고를 게 없다
  if (kind === 'cash') {
    const cash = accounts[0]
    if (cash) {
      /* 고를 게 없다 — 결제수단에서 [현금]을 고르면 부르는 폼이 이 계정으로 채운다. 여기선 어디서 나가는지만 말한다.
         (칩을 또 누르게 했더니 같은 걸 두 번 골랐다 — 2026-09-30 사용자) */
      /* ⚠ 그리면서 채우지 않는다 — 계정 없이 저장된 옛 현금 거래를 열기만 해도 붙어, 저장하면 옛 거래의
         시재 잔액이 바뀐다. 채우는 건 [현금]을 **누를 때**(부르는 폼)뿐. 비어 있으면 잡을지 묻는다 */
      if (value === cash[valueKey]) {
        return (
          <div className="row gap-6 text-sm" style={{ alignItems: 'center', color: 'var(--muted)' }}>
            <Icon.Wallet size={14}/> <b style={{ color: 'var(--ink)' }}>{cash.name}</b> 계정(금고 시재)에서 나가요.
          </div>
        )
      }
      return (
        <div className="row gap-8 text-sm" style={{ alignItems: 'center', color: 'var(--muted)' }}>
          <Icon.Wallet size={14}/> 금고 시재에 안 잡힌 현금 거래예요(비용만 잡힘).
          <button type="button" className="btn sm" onClick={() => onChange(cash[valueKey], cash)}>{cash.name} 계정에 잡기</button>
        </div>
      )
    }
    const canAdd = can('master_account', 'create')
    return (
      <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="text-xs text-muted2">현금 계정이 없어요 — 없어도 비용은 잡히고, 만들면 금고 시재 잔액이 관리됩니다.</span>
        {canAdd && (
          <button type="button" className="btn sm" disabled={busy} onClick={async () => {
            setBusy(true)
            const r = await api.addAccount({ name: '현금', type: '현금', kind: 'bank', owner: 'corp' })
            setBusy(false)
            if (!r.ok) return toast.push(r.error || '현금 계정을 만들지 못했어요', { tone: 'warn' })
            toast.push("현금 계정을 기준정보에 만들었어요")
            const made = { id: r.id, name: '현금', type: '현금', kind: 'bank' }
            await onCreated?.(made)
            onChange(made[valueKey], made)
          }}><Icon.Plus size={12}/> 현금 계정 만들기</button>
        )}
      </div>
    )
  }

  const w = WORD[kind] || WORD.bank
  const sel = accounts.find(a => a[valueKey] === value) || null
  const canAdd = can(w.res, 'create')

  // ── 새로 만들기
  const dupByNumber = digits(draft.number).length >= 4
    ? all.find(a => digits(a.number) === digits(draft.number) && (a.kind === 'card') === (kind === 'card')) : null
  const dupByName = draft.name.trim() ? all.find(a => String(a.name || '').trim() === draft.name.trim()) : null
  const save = async () => {
    if (!draft.name.trim()) return toast.push(`${w.name}을 적어 주세요`, { tone: 'warn' })
    if (dupByNumber) return toast.push(`번호가 같은 ${w.what} "${dupByNumber.name}"가 이미 있어요 — 그걸 고르세요`, { tone: 'warn' })
    if (dupByName) return toast.push(`같은 이름의 ${dupByName.kind === 'card' ? '카드' : '계좌'}가 있어요 — 끝자리를 붙이는 등 이름을 달리해 주세요`, { tone: 'warn' })
    setBusy(true)
    const body = kind === 'card'
      ? { name: draft.name.trim(), bank: draft.bank.trim(), number: draft.number.trim(), kind: 'card', type: '카드', owner: 'corp', card_type: 'credit' }
      : { name: draft.name.trim(), bank: draft.bank.trim(), number: draft.number.trim(), kind: 'bank', type: '보통예금', owner: 'corp' }
    const r = await api.addAccount(body)
    setBusy(false)
    if (!r.ok) return toast.push(r.error || `${w.what}를 등록하지 못했어요`, { tone: 'warn' })
    toast.push(kind === 'card'
      ? `새 카드 "${body.name}"를 기준정보에 등록했어요 — 결제일은 기준정보 › 카드에서 정해 주세요`
      : `새 계좌 "${body.name}"를 기준정보에 등록했어요`)
    const made = { ...body, id: r.id, bankName: body.bank }
    await onCreated?.(made)
    onChange(made[valueKey], made)
    setAdding(false); setDraft({ name: '', bank: '', number: '' })
  }

  const cell = (label, v, mono) => (
    <div style={{ minWidth: 0 }}>
      <div className="text-xs text-muted2" style={{ marginBottom: 4 }}>{label}</div>
      <div className={`ro-field${mono ? ' num' : ''}`} style={{ minHeight: 40, padding: '9px 12px', color: v ? undefined : 'var(--muted-2)' }}>{v || '—'}</div>
    </div>
  )
  const input = (label, k, ph, mono) => (
    <div style={{ minWidth: 0 }}>
      <div className="text-xs text-muted2" style={{ marginBottom: 4 }}>{label}{k === 'name' && <span style={{ color: 'var(--neg-ink)' }}> *</span>}</div>
      <input className={`input${mono ? ' num' : ''}`} value={draft[k]} placeholder={ph}
        onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}/>
    </div>
  )
  // 세 칸 — 좁으면 한 줄씩(.acct-field-cells)
  return (
    <div className="col gap-8">
      {!adding && (
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* 없는 이름을 치면 그 이름으로 바로 [새 … 로 등록] — [+ 새 …]를 따로 누르지 않아도 된다 */}
            <Combobox value={value || ''} allowAdd={canAdd} placeholder={placeholder || `${w.name}·${w.org}·번호로 찾기`}
              onAddNew={q => { setDraft({ name: q, bank: '', number: '' }); setAdding(true) }}
              addNewLabel={`새 ${w.what}로 등록`}
              onChange={v => onChange(v, accounts.find(a => a[valueKey] === v))}
              options={accounts.map(a => ({
                value: a[valueKey], label: a.name,
                sub: [isMain(a) ? MAIN_BADGE : '', kind === 'any' && a.kind === 'card' ? '카드' : '', a.bankName || a.bank, a.number].filter(Boolean).join(' · '),
                keywords: `${a.bankName || a.bank || ''} ${a.number || ''} ${digits(a.number)}`,
              }))}/>
          </div>
          {canAdd
            ? <button type="button" className="btn sm" style={{ flexShrink: 0 }} onClick={() => setAdding(true)}>
                <Icon.Plus size={12}/> 새 {w.what}
              </button>
            : null}
        </div>
      )}
      <div className="acct-field-cells">
        {adding ? <>
          {input(w.name, 'name', w.ph[0])}
          {input(w.org, 'bank', w.ph[1])}
          {input(w.no, 'number', w.ph[2], true)}
        </> : <>
          {cell(w.name, sel?.name)}
          {cell(w.org, sel?.bankName || sel?.bank)}
          {cell(w.no, sel?.number, true)}
        </>}
      </div>
      {adding && (
        <>
          {/* 번호가 같으면 이미 있는 것 — 만들지 말고 그걸 고르게 한다 */}
          {dupByNumber && (
            <div className="row gap-8 text-xs" style={{ alignItems: 'center', color: 'var(--warn-ink)' }}>
              번호가 같은 {w.what} "{dupByNumber.name}"가 이미 있어요.
              <button type="button" className="btn ghost sm" onClick={() => {
                onChange(dupByNumber[valueKey], dupByNumber); setAdding(false); setDraft({ name: '', bank: '', number: '' })
              }}>그걸로 고르기</button>
            </div>
          )}
          {!dupByNumber && dupByName && (
            <div className="text-xs" style={{ color: 'var(--warn-ink)' }}>
              같은 이름이 이미 있어요 — 끝자리를 붙이는 등 이름을 달리해 주세요.
            </div>
          )}
          <div className="row gap-8" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn sm" onClick={() => { setAdding(false); setDraft({ name: '', bank: '', number: '' }) }}>취소</button>
            <button type="button" className="btn primary sm" disabled={busy} onClick={save}>
              {busy ? '등록 중…' : `${w.what} 등록하고 고르기`}
            </button>
          </div>
        </>
      )}
      {!adding && !canAdd && accounts.length === 0 && (
        <div className="text-xs text-muted2">등록된 {w.what}가 없어요. {w.what} 등록은 기준정보 권한이 있는 담당자에게 요청해 주세요.</div>
      )}
    </div>
  )
}
