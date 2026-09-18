import { useState, useEffect, useRef } from 'react'
import { Icon, useToast, setFiscalEndMonth } from '../ui'
import { api } from '../api'
import { usePerms } from '../perms'
import { BizSection, ContactSection, FiscalSection, emptyCompanyForm, companyFormOf, focusCompanyField } from './CompanyFields'

/* 첫 설정 — 회사 정보(사업자번호)가 없으면 앱에 들어가기 전에 받는다.
 *
 * 비밀번호 강제 변경과 같은 층(App)에서 가른다. 뒤에 앱을 깔고 덮으면 사이드바 배지·홈 요약이
 * 빈 회사 정보로 먼저 돌고, 가려진 화면이 조작될 여지도 남는다.
 *
 * 필수는 상호·사업자번호 둘뿐이다(사용자 확정 2026-09-15 — 기수는 선택).
 * 사업자번호는 나중에 환경설정 › 회사 정보에서 바꿀 수 있으므로 저장 전 확인창을 두지 않는다.
 *
 * 입력 칸은 환경설정 › 회사 정보와 **같은 부품**이다(CompanyFields).
 */
export const CompanySetup = ({ onDone, onLogout }) => {
  const toast = useToast()
  const { can } = usePerms()
  const canEdit = can('settings', 'edit')
  const [form, setForm] = useState(emptyCompanyForm)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const touchedRef = useRef(false)

  useEffect(() => {
    if (!canEdit) return
    let alive = true
    // 새 회사는 상호만 심어져 있다(provision.js) — 있는 값은 살린다
    // 응답이 늦게 와서 이미 치고 있던 칸을 덮지 않는다
    api.getCompany().then(co => { if (alive && co && !touchedRef.current) setForm(companyFormOf(co)) })
    return () => { alive = false }
  }, [canEdit])

  /* 뒤 화면이 스크롤되면 덮은 게 아니라 떠 있는 것처럼 보인다 */
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const f = (k, v) => {
    touchedRef.current = true
    setErrors(e => (e[k] ? { ...e, [k]: '' } : e))
    setForm(p => ({ ...p, [k]: v }))
  }

  const save = async () => {
    setBusy(true)
    const res = await api.saveCompany(form)
    setBusy(false)
    if (res.ok) setFiscalEndMonth(form.fiscal_end_month)   // 보고서 '올해' = 이 회기(4단계)
    if (!res.ok) {
      // 서버가 어느 칸인지 알려주면 그 칸 아래에 붙이고 데려간다
      if (res.field) {
        setErrors({ [res.field]: res.error })
        if (focusCompanyField(res.field)) return
      }
      return toast.push(res.error || '저장하지 못했어요', { tone: 'warn' })
    }
    onDone()
  }

  /* 권한 없는 직원 — 관리자가 입력을 마쳤는지 다시 본다. 이게 없으면 관리자가 저장한 뒤에도
     로그아웃·재로그인 말고는 들어갈 길이 없다. */
  const recheck = async () => {
    setBusy(true)
    const r = await api.loadCompany()
    setBusy(false)
    if (r.ok && String(r.company?.biz_no || '').trim()) return onDone()
    toast.push('아직 입력되지 않았습니다')
  }

  return (
    <div className="wz">
      <div className="wz-inner">
        <div className="wz-stage">
          <div className="wz-head">
            <div className="wz-title">{canEdit ? '회사 정보를 입력해주세요' : '아직 시작할 수 없습니다'}</div>
            <div className="wz-sub">
              {canEdit ? '처음 한 번만 입력하면 됩니다.' : '관리자가 회사 정보를 먼저 입력해야 시작할 수 있습니다.'}
            </div>
          </div>

          {canEdit && <>
            {/* 사업자 정보가 실제로 쓰이는 두 곳을 말한다(2026-09-15, 사용자가 문구 판단을 맡김):
                ① 거래명세서·결의서·이체표 등 인쇄물의 공급자란 ② 홈택스 세금계산서 가져오기의 매출·매입 판정.
                그래서 '정확하게'의 이유가 생긴다. 바꿀 수는 있으므로 '변경 불가'는 말하지 않는다. */}
            <div className="card card-pad cs-notice">
              <Icon.Warn size={16}/>
              <div>
                사업자 정보는 거래명세서 등 문서에 그대로 찍히고, 사업자번호로 세금계산서의 매출·매입을 가릅니다.
                <b> 사업자등록증과 똑같이 입력하세요.</b>
                <div style={{ marginTop: 4 }}>개인 용도로 쓰실 때는 사업자번호에 주민번호 앞 6자리만 입력하세요.</div>
              </div>
            </div>
            <div className="col" style={{ gap: 14 }}>
              <BizSection form={form} f={f} errors={errors}/>
              <FiscalSection form={form} f={f} errors={errors}/>
              <ContactSection form={form} f={f} errors={errors}/>
            </div>
          </>}
        </div>

        <div className="wz-foot">
          <button className="btn ghost" onClick={onLogout} disabled={busy}>로그아웃</button>
          <div style={{ marginLeft: 'auto' }}>
            {canEdit
              ? <button className="btn primary wz-cta" onClick={save} disabled={busy}>{busy ? '저장 중…' : '저장하고 시작'}</button>
              : <button className="btn primary wz-cta" onClick={recheck} disabled={busy}>{busy ? '확인 중…' : '다시 확인'}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
