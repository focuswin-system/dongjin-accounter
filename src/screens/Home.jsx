import { useState, useEffect } from 'react'
import { Icon, Popover, PopItem, fmtNum } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { LEAF_BY_ID, MASTER_LEAVES } from '../lib/nav'
import { usePerms, visiblePortal, visibleLeaves, isMasterOnly } from '../lib/perms'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { SetupWizard, useSetupStatus, setupProgress } from '../lib/components/SetupWizard'

const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"]
const todayLabel = () => {
  const d = new Date()
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK_KO[d.getDay()]}요일`
}

// 할 일 종류별 아이콘/색 (클라이언트 표시 전용)
const TODO_KIND_META = {
  ar:       { icon: <Icon.In size={15}/>,      toneColor: 'var(--brand)',    soft: 'var(--brand-soft)' },
  doc:      { icon: <Icon.Sign size={15}/>,    toneColor: 'var(--warn-ink)', soft: 'var(--warn-soft)' },
  evidence: { icon: <Icon.Receipt size={15}/>, toneColor: 'var(--warn-ink)', soft: 'var(--warn-soft)' },
  ap:       { icon: <Icon.Bank size={15}/>,    toneColor: 'var(--neg-ink)',  soft: 'var(--neg-soft)' },
}

const DEFAULT_FAVS = ['income', 'expense', 'billing_issued', 'contract', 'tax_vat']

/* 자금 요약 — 홈에서 매일 보는 네 숫자.
 *
 * 중소기업이 무너지는 건 대개 적자가 아니라 흑자도산이다. 손익은 흑자인데 미수금이 안 들어와
 * 급여일에 현금이 없는 것. 그래서 손익보다 이 네 개를 먼저 보여준다.
 * 자세한 계좌별 잔액·날짜별 예정은 자금일보에서 본다(여기서 다 보여주면 홈이 무거워진다).
 */
/* 첫 세팅 카드 — 필수 항목이 다 채워지면 스스로 사라진다.
   빈 상태에서 이 앱을 처음 켜면 할 일 목록도 자금 숫자도 다 0이라 볼 게 없다.
   그때 화면에 남는 건 "뭐부터 하지"뿐인데, 그 물음에 답하는 자리가 없었다. */
const SetupCard = ({ onOpen }) => {
  const status = useSetupStatus(0)
  const { done, total, allDone } = setupProgress(status)
  if (!status || allDone) return null
  return (
    <button className="card card-pad" onClick={onOpen}
      style={{ width: '100%', textAlign: 'left', cursor: 'pointer', marginBottom: 20,
        border: '1px solid var(--brand)', background: 'var(--brand-soft)' }}>
      <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Icon.Sparkle size={18}/>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="fw-700">처음 세팅이 아직 끝나지 않았어요</div>
          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
            회사 정보·계좌·거래처를 채우면 청구서와 명세서가 자동으로 채워져요.
          </div>
        </div>
        {/* 몇 개 남았는지가 이 카드의 핵심이다 — '아직'만 말하면 얼마나 남았는지 몰라 미룬다 */}
        <span className="num fw-700" style={{ fontSize: 15 }}>{done} / {total}</span>
        <Icon.Right size={16}/>
      </div>
    </button>
  )
}

const CashSummary = ({ go }) => {
  const [d, setD] = useState(null)
  useEffect(() => { api.getCashSummary().then(setD).catch(() => {}) }, [])
  if (!d) return null

  const short = d.lowest && d.lowest.balance < 0
  const cards = [
    { label: '지금 쓸 수 있는 돈', value: d.available, sub: `통장 ${d.accountCount}개` },
    /* sub 는 '이번 주'가 아니라 **전체 미수금·미지급금**이다. 예전엔 '받을 돈'·'나갈 돈'이라고만
       적어서, 위 라벨('이번 주 나갈 돈')과 거의 같은 말에 다른 숫자가 붙었다 —
       57,363,900 옆에 57,918,900 이 붙어 있으면 어느 쪽이 이번 주인지 알 수 없다. */
    /* ⚠ 들어올 돈과 나갈 돈에서 **기약 없는 돈의 뜻이 다르다.**
       · 들어올 돈: 장기 미수·기한 미정·오래 밀린 것은 weekIn 에서 **빠져 있다**(없는 셈).
         그래서 "따로 ○○원이 걸려 있다"고 말한다 — 더한 값이 아니다.
       · 나갈 돈: 기한을 몰라도 weekOut 에 **들어 있다**(있는 셈). 그래서 "그중 ○○원"이다.
       같은 말을 쓰면 한쪽은 반드시 오해된다. */
    { label: '이번 주 들어올 돈', value: d.weekIn, tone: 'pos',
      sub: d.uncertainIn > 0
        ? `기약 없는 돈 ${fmtNum(d.uncertainIn)}원은 뺐어요`
        : `미수금 전체 ${fmtNum(d.receivable.total)}원` },
    { label: '이번 주 나갈 돈', value: d.weekOut, tone: 'neg-ink',
      sub: d.uncertainOut > 0
        ? `그중 ${fmtNum(d.uncertainOut)}원은 기한 미정`
        : `미지급금 전체 ${fmtNum(d.payable.total)}원` },
    { label: '이번 주 최저 잔액', value: d.lowest?.balance ?? d.available,
      sub: d.lowest?.date === d.date ? '오늘이 가장 낮아요' : d.lowest?.date || '', tone: short ? 'neg-ink' : undefined },
  ]

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="row" style={{ marginBottom: 10, padding: '0 2px', alignItems: 'center' }}>
        <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', letterSpacing: '0.02em' }}>자금 현황</div>
        <button className="btn ghost sm ml-auto" onClick={() => go('cash_report')}>
          자금일보 <Icon.Right size={11}/>
        </button>
      </div>
      {short && (
        <div className="card card-pad" style={{ marginBottom: 10, borderColor: 'var(--neg)', background: 'rgba(220,38,38,0.04)' }}>
          <div className="text-sm fw-700" style={{ color: 'var(--neg-ink)' }}>
            이번 주 {d.lowest.date}에 잔액이 {fmtNum(d.lowest.balance)}원까지 떨어져요
          </div>
          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
            미수금을 앞당겨 받거나 지급 일정을 조정해야 할 수 있어요.
          </div>
        </div>
      )}
      {/* 카드 전체를 누르면 자금일보로 — 감싸는 div 에 클릭을 걸어 Kpi 를 그대로 쓴다 */}
      {/* 래퍼에 minWidth:0 이 필요하다 — Kpi 는 카드에 그걸 걸어 nowrap 금액이 그리드 트랙을
          밀지 않게 한다. 래퍼를 씌우면 래퍼가 그리드 아이템이 되어 그 방어가 사라진다. */}
      <KpiRow cols={4}>
        {cards.map(c => (
          <div key={c.label} onClick={() => go('cash_report')} style={{ cursor: 'pointer', minWidth: 0 }}>
            <Kpi label={c.label} value={c.value} tone={c.tone} hint={c.sub}/>
          </div>
        ))}
      </KpiRow>
      {d.overdueCount > 0 && (
        <div className="text-xs" style={{ marginTop: 8, color: 'var(--neg-ink)' }}>
          기한이 지난 입출금 {d.overdueCount}건이 예정에 섞여 있어요 — 실제로는 더 늦게 들어올 수 있습니다.
        </div>
      )}
    </div>
  )
}

export const HomeScreen = ({ go, user, openIncome, openExpense }) => {
  // 홈 타일·즐겨찾기도 사이드바와 같은 규칙으로 가린다.
  // (홈에는 보이는데 메뉴엔 없으면 사용자는 어디서 들어가는 화면인지 알 수 없다)
  const { perms, can: canDo } = usePerms()
  const portal = visiblePortal(perms)
  // 마스터 전용 화면(변경 이력)은 자원 권한과 별개라 여기서 한 번 더 거른다 —
  // 즐겨찾기·자주 찾는 메뉴에 눌러도 못 들어가는 항목이 뜨면 안 된다.
  const leaves = visibleLeaves(perms).filter(l => !isMasterOnly(l.id) || user?.role === 'admin')
  // 기준정보는 15개 화면의 묶음이라, 그중 하나라도 볼 수 있으면 타일을 세운다(App 사이드바와 같은 규칙).
  const masterVisible = MASTER_LEAVES.some(l => canDo(l.id))
  const [setupOpen, setSetupOpen] = useState(false)
  const [todos, setTodos] = useState([])
  const [favorites, setFavorites] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('homeFavorites')); return Array.isArray(s) ? s : DEFAULT_FAVS } catch { return DEFAULT_FAVS }
  })

  useEffect(() => { api.getHomeTodos().then(setTodos).catch(() => {}) }, [])
  useEffect(() => { localStorage.setItem('homeFavorites', JSON.stringify(favorites)) }, [favorites])

  // 할 일은 청구서 상태에서 파생된다 — 정산하면 다음 조회에서 자연히 빠지므로 별도 완료표시가 없다
  // 갈 수 없는 화면의 할 일은 보여주지 않는다 — 눌러도 못 가는 항목은 할 일이 아니다
  const pendingTodos = todos
    .filter(t => canDo(t.kind === "ap" ? "ap" : "ar"))
    .map(t => ({ ...t, ...TODO_KIND_META[t.kind] }))

  // 예전에는 여기서 모달을 띄우고 '입금이 처리되었어요'를 보여줬지만, 실제로는 아무 거래도
  // 만들지 않는 빈 호출이었다(api.completeTodo 는 {ok:true}만 돌려주는 스텁). 사용자는 돈이
  // 기록된 줄 알았지만 장부에는 아무것도 남지 않았다.
  // 정산은 청구서 상세의 정상 경로(계좌 선택·매칭·잔액 반영)에서만 이뤄져야 하므로 그리로 보낸다.
  const handleTodoAction = (t) => {
    if (t.kind === "ar")      go("ar", { invoiceId: t.invoiceId })
    else if (t.kind === "ap") go("ap", { invoiceId: t.invoiceId })
  }

  const addFav = (id) => setFavorites(f => f.includes(id) ? f : [...f, id])
  const removeFav = (id) => setFavorites(f => f.filter(x => x !== id))


  return (
    <>
    <div className="fade-up">
      {/* Hero */}
      <PageHeader
        title={`${user?.displayName || "관리자"}님, 안녕하세요`}
        sub={todayLabel()}
        actions={<>
          {canDo("settings") && <button className="btn" onClick={() => go("settings")}><Icon.Cog size={15}/> <span className="btn-label-hide">환경설정</span></button>}
          <Popover align="right" width={220}
            trigger={<button className="btn primary"><Icon.Plus/> 거래 등록 <Icon.Down size={12} style={{ marginLeft: 2 }}/></button>}>
            <div style={{ padding: 6 }}>
              <PopItem icon={<Icon.In size={16}/>}    label="입금 등록"   sub="발주처 입금"      onClick={openIncome}/>
              <PopItem icon={<Icon.Out size={16}/>}   label="지출 등록"   sub="외주·자재·운영비" onClick={openExpense}/>
              {/* 엑셀 업로드는 여태 각 화면 안에만 있어서, 처음 쓰는 사람은 있는 줄도 몰랐다.
                  이미 엑셀로 일하던 자료를 옮기는 게 진입 비용을 가장 크게 낮추는 길이라
                  가장 잘 보이는 자리에 무엇을 올릴 수 있는지 함께 적는다. */}
              <div style={{ height: 1, background: "var(--line)", margin: "6px 0" }}/>
              <div className="text-xs text-muted2" style={{ padding: "4px 10px 2px" }}>엑셀로 가져오기</div>
              <PopItem icon={<Icon.Excel size={16}/>} label="거래내역"  sub="입출금 여러 건"   onClick={() => go("excel_modal")}/>
              <PopItem icon={<Icon.Excel size={16}/>} label="거래처"    sub="매출처·매입처"   onClick={() => go("master_vendor")}/>
              <PopItem icon={<Icon.Excel size={16}/>} label="품목"      sub="단가표"          onClick={() => go("master_item")}/>
              <PopItem icon={<Icon.Excel size={16}/>} label="세금계산서" sub="홈택스 내려받기" onClick={() => go("billing_issued")}/>
            </div>
          </Popover>
        </>}
      />

      {/* 첫 세팅 — 기준정보가 비어 있을 때만 뜬다.
          다 채워지면 조용히 사라진다(끝난 일을 계속 보여주면 그게 잔소리가 된다).
          '자금 현황'보다 위에 두는 이유: 세팅 전에는 자금 숫자가 다 0이라 볼 게 없다. */}
      <SetupCard onOpen={() => setSetupOpen(true)}/>

      {/* 자금 현황 — 아침에 제일 먼저 보는 숫자. 자세한 건 자금일보로 들어간다.
          여기 있는 게 도움말(App.jsx)이 말하던 '자금 현황 카드'다 — 문구만 있고 구현이 없었다. */}
      {canDo("cash_report") && <CashSummary go={go}/>}

      <SetupWizard open={setupOpen} onClose={() => setSetupOpen(false)} onGo={go}/>

      {/* 지금 해야 할 일 */}
      <div style={{ marginBottom: 24 }}>
        <div className="text-xs fw-700" style={{ color: "var(--muted-2)", letterSpacing: "0.02em", marginBottom: 10, padding: "0 2px" }}>
          지금 해야 할 일 <span className="num" style={{ color: "var(--brand-ink)", marginLeft: 4 }}>{pendingTodos.length}</span>
        </div>
        {pendingTodos.length === 0 ? (
          <div className="card" style={{ padding: "18px 20px", display: "flex", alignItems: "center", gap: 10, color: "var(--muted)" }}>
            <Icon.Check size={18} className="text-pos"/>
            <span className="text-sm fw-600" style={{ color: "var(--ink)" }}>지금 처리할 일이 없어요.</span>
          </div>
        ) : (
          <div className="todo-grid">
            {pendingTodos.slice(0, 4).map(t => (
              <button key={t.id} type="button" className="todo-card" onClick={() => handleTodoAction(t)}>
                <span className="todo-ico" style={{ background: t.soft, color: t.toneColor }}>{t.icon}</span>
                <span className="todo-main">
                  <span className="todo-tag" style={{ color: t.toneColor }}>{t.tag}</span>
                  <span className="todo-title">{t.title}</span>
                  {t.sub && <span className="todo-sub">{t.sub}</span>}
                </span>
                <span className="todo-go">{t.action} <Icon.Right size={12}/></span>
              </button>
            ))}
            {pendingTodos.length > 4 && (
              <button type="button" className="todo-card todo-more" onClick={() => go("ar")}>
                <span className="todo-main">
                  <span className="todo-title">+{pendingTodos.length - 4}건 더</span>
                  <span className="todo-sub">미수금·미지급금에서 전체 보기</span>
                </span>
                <Icon.Right size={14}/>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 자주 찾는 메뉴 */}
      <div style={{ marginBottom: 26 }}>
        <div className="text-xs fw-700" style={{ color: "var(--muted-2)", letterSpacing: "0.02em", marginBottom: 10, padding: "0 2px" }}>자주 찾는 메뉴</div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {favorites.map(id => {
            const l = LEAF_BY_ID[id]
            // 즐겨찾기는 localStorage에 남아 있다 — 권한을 잃은 화면은 조용히 뺀다
            if (!l || !canDo(id.startsWith("settings") ? "settings" : id)) return null
            const Ic = l.icon
            return (
              <div key={id} className="fav-chip" onClick={() => go(id)}>
                <Ic className="nav-ico" style={{ width: 15, height: 15, opacity: 0.7 }}/>
                <span>{l.label}</span>
                <span className="fav-x" onClick={(e) => { e.stopPropagation(); removeFav(id) }} title="제거"><Icon.Close size={13}/></span>
              </div>
            )
          })}
          <Popover align="left" width={260}
            trigger={<button className="fav-chip" style={{ borderStyle: "dashed", color: "var(--muted)" }}><Icon.Plus size={14}/> 추가</button>}>
            <div style={{ maxHeight: 320, overflowY: "auto", padding: 6 }}>
              {leaves.map(l => {
                const active = favorites.includes(l.id)
                const Ic = l.icon
                return (
                  <button key={l.id} data-pop-item onClick={() => active ? removeFav(l.id) : addFav(l.id)}
                    className="row gap-8" style={{ width: "100%", padding: "8px 10px", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left", borderRadius: 8 }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <Ic className="nav-ico" style={{ width: 15, height: 15, opacity: 0.7, flexShrink: 0 }}/>
                    <span className="text-sm fw-600" style={{ flex: 1 }}>{l.label}</span>
                    <span className="text-xs text-muted2">{l.domain || ""}</span>
                    {active && <Icon.Check size={14} style={{ color: "var(--brand)" }}/>}
                  </button>
                )
              })}
            </div>
          </Popover>
        </div>
      </div>

      {/* 도메인 라인 → 통일된 카테고리 카드(하위메뉴 나열 없이 깔끔하게, 클릭 시 해당 영역으로) */}
      {portal.map(domain => {
        const Dic = domain.icon
        return (
          <div key={domain.id} className="domain-line">
            <div className="domain-line-head">
              <div className="d-ico"><Dic size={15}/></div>
              <div className="d-label">{domain.label}</div>
            </div>
            <div className="tile-row">
              {domain.categories.map(cat => {
                const Cic = cat.icon
                return (
                  <button key={cat.id} className="cat-tile" onClick={() => go(cat.route || cat.id)}>
                    <div className="c-ico"><Cic size={20}/></div>
                    <div className="c-label">{cat.label}</div>
                    {cat.desc && <div className="c-desc">{cat.desc}</div>}
                    <div className="c-go">바로가기 <Icon.Right size={11}/></div>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* 기준정보·환경설정 — 매일 쓰는 업무 메뉴와 성격이 달라 아래에 따로 세운다(사이드바와 같은 묶음).
       *
       * ⚠ 기준정보는 일반회계 안에 있다가 독립 영역으로 빠져나왔는데(인사 기준정보까지 모으므로),
       * 사이드바에만 세우고 **홈에는 자리를 안 만들어 두었었다** — 메뉴엔 있는데 홈에선
       * 들어갈 길이 없는 상태였다. nav.js visiblePortal 주석이 경계하는 것의 정반대 경우다. */}
      {(masterVisible || canDo("settings")) && (
        <div className="domain-line" style={{ marginBottom: 0 }}>
          <div className="domain-line-head">
            <div className="d-ico" style={{ background: "var(--surface-3)", color: "var(--muted)" }}><Icon.Folder size={15}/></div>
            <div className="d-label">기준정보 · 환경설정</div>
          </div>
          <div className="tile-row">
            {/* 기준정보는 15개 화면의 묶음이라, 그중 하나라도 볼 수 있으면 타일을 세운다(사이드바와 같은 규칙) */}
            {masterVisible && (
              <button className="cat-tile" onClick={() => go("master")}>
                <div className="c-ico" style={{ background: "var(--surface-3)", color: "var(--muted)" }}><Icon.Folder size={20}/></div>
                <div className="c-label">기준정보</div>
                <div className="c-desc">거래처·품목·계정과목·계좌·부서 등</div>
                <div className="c-go">바로가기 <Icon.Right size={11}/></div>
              </button>
            )}
            {canDo("settings") && (
              <button className="cat-tile" onClick={() => go("settings")}>
                <div className="c-ico" style={{ background: "var(--surface-3)", color: "var(--muted)" }}><Icon.Cog size={20}/></div>
                <div className="c-label">환경설정</div>
                <div className="c-desc">회사 정보·사용자·결재선·월 마감·변경 이력</div>
                <div className="c-go">바로가기 <Icon.Right size={11}/></div>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
    </>
  )
}
