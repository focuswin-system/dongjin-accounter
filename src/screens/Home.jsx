import { useState, useEffect, useMemo } from 'react'
import { Icon, Popover, PopItem } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { MASTER_LEAVES, filterPortalDocs } from '../lib/nav'
import { usePerms, visiblePortal } from '../lib/perms'
import { CashPanel } from '../lib/components/CashPanel'
import { QuickTiles } from '../lib/components/QuickTiles'
import { SetupWizard, useSetupStatus, setupProgress } from '../lib/components/SetupWizard'

const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"]
const todayLabel = () => {
  const d = new Date()
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK_KO[d.getDay()]}요일`
}

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

export const HomeScreen = ({ go, user, navHidden, docKeys, openIncome, openExpense }) => {
  // 홈 타일·즐겨찾기도 사이드바와 같은 규칙으로 가린다.
  // (홈에는 보이는데 메뉴엔 없으면 사용자는 어디서 들어가는 화면인지 알 수 없다)
  const { perms, can: canDo } = usePerms()
  const portal = visiblePortal(perms)
  // 마스터 전용 화면(변경 이력)은 자원 권한과 별개라 여기서 한 번 더 거른다 —
  // 즐겨찾기·자주 찾는 메뉴에 눌러도 못 들어가는 항목이 뜨면 안 된다.
  // 기준정보는 15개 화면의 묶음이라, 그중 하나라도 볼 수 있으면 타일을 세운다(App 사이드바와 같은 규칙).
  const masterVisible = MASTER_LEAVES.some(l => canDo(l.id))
  const [setupOpen, setSetupOpen] = useState(false)
  /* '지금 해야 할 일' 구획은 뺐다. 미수·미지급 독촉은 알림(헤더 종)과 각 화면이 이미 맡고
     있어서, 홈에서 같은 것을 한 번 더 세우면 자금 카드와 무게를 나눠 가진다.
     ⚠ 데이터도 함께 뺀다 — 화면만 지우고 호출을 남기면 홈을 열 때마다 쓰지 않을 조회가 돈다. */

  /* 메뉴 탭 — 도메인 하나가 탭 하나. 기준정보·환경설정은 성격이 달라 마지막 탭으로 묶는다.
     권한이 없어 볼 게 없는 탭은 아예 세우지 않는다(눌러서 빈 화면을 보게 하지 않는다). */
  const menuTabs = useMemo(() => {
    /* ⚠ 접어 둔 대메뉴(navHidden)는 여기서도 뺀다. 사이드바에서만 걸러 두면 첫 안내에서
       '안 쓴다'고 고른 도메인이 홈에는 탭으로 그대로 남는다 — 두 화면이 다른 말을 한다.
       ※ 포털 도메인 id 는 nav 도메인 id 와 같은 값을 쓴다(nav.js DOMAIN_OF). */
    const hidden = new Set(navHidden || [])
    const tabs = portal
      /* 회사가 안 쓰는 문서도 뺀다. 넷 다 껐으면 '문서' 타일 자체가 사라진다 —
         눌러서 빈 판을 보게 하지 않는다(사이드바와 같은 규칙). */
      .map(d => ({ ...d, categories: d.categories.map(c => filterPortalDocs(c, docKeys)).filter(Boolean) }))
      .filter(d => d.categories.length > 0 && !hidden.has(d.id))
      .map(d => ({ id: d.id, label: d.label, items: d.categories }))
    const base = []
    if (masterVisible) base.push({ id: 'master', label: '기준정보', icon: Icon.Folder, desc: '거래처·품목·계정과목·계좌·부서 등' })
    if (canDo('settings')) base.push({ id: 'settings', label: '환경설정', icon: Icon.Cog, desc: '회사 정보·사용자·결재선·월 마감' })
    if (base.length) tabs.push({ id: '__base', label: '기준 자료', items: base })
    return tabs
  }, [portal, masterVisible, navHidden, docKeys])
  const [menuTab, setMenuTab] = useState(null)
  // 첫 탭을 기본으로. 권한이 바뀌어 그 탭이 사라지면 다시 첫 탭으로 되돌린다.
  useEffect(() => {
    if (!menuTabs.length) return
    if (!menuTab || !menuTabs.some(t => t.id === menuTab)) setMenuTab(menuTabs[0].id)
  }, [menuTabs, menuTab])


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

      {/* 바로가기 — 떠 있는 독과 같은 목록. 자주 여는 화면이 홈 맨 위에 있어야 한다. */}
      <QuickTiles go={go} canDo={canDo}/>

      {/* 자금 현황 — 아침에 제일 먼저 보는 숫자. 자세한 건 자금일보로 들어간다.
          여기 있는 게 도움말(App.jsx)이 말하던 '자금 현황 카드'다 — 문구만 있고 구현이 없었다. */}
      {canDo("cash_report") && <CashPanel go={go}/>}

      <SetupWizard open={setupOpen} onClose={() => setSetupOpen(false)} onGo={go}/>

      {/* 메뉴 — **탭 하나에 도메인 하나**, 그 안은 큰 아이콘.
       *
       * 예전엔 도메인 일곱이 세로로 줄줄이 쌓여 홈이 그만큼 길었다(각 줄에 248px 타일들).
       * 탭으로 접으면 한 화면에 들어오고, 찾는 사람은 어차피 한 덩어리만 본다.
       * 아이콘 모양은 위 바로가기와 같게 둔다 — 같은 '고르는 자리'가 두 가지 모양이면
       * 눈이 두 번 배워야 한다. 대신 색은 안 쓴다(색은 사용자가 고른 바로가기의 몫).
       *
       * 탭 줄은 좁아지면 가로로 스크롤된다(.tab-bar 가 이미 그렇게 되어 있다) —
       * 모바일에서 탭이 줄바꿈되며 두세 줄로 부풀지 않는다. */}
      <div style={{ marginBottom: 24 }}>
        <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', letterSpacing: '0.02em', marginBottom: 10, padding: '0 2px' }}>메뉴</div>
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* 전역 .tab(밑줄형)은 다른 화면이 전부 쓰므로 건드리지 않고 전용 알약형을 쓴다.
              여기서는 '지금 어느 묶음을 보고 있나'가 한눈에 들어와야 해서 밑줄로는 약하다. */}
          <div className="mtabs">
            {menuTabs.map(t => (
              <button key={t.id} className={`mtab${menuTab === t.id ? ' active' : ''}`}
                onClick={() => setMenuTab(t.id)}>{t.label}</button>
            ))}
          </div>
          <div className="menu-icons">
            {(menuTabs.find(t => t.id === menuTab)?.items || []).map(it => {
              const Ic = it.icon
              return (
                <button key={it.id} className="quick-tile" title={it.desc || ''} onClick={() => go(it.route || it.id)}>
                  <span className="qt-ico qt-ico-soft"><Ic size={24}/></span>
                  <span className="qt-label">{it.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
    </>
  )
}
