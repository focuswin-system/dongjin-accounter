import { useState } from 'react'
import { Icon, fmtNum, useToast, Spacer, StatusBadge } from '../lib/ui'
import { PAYROLL_CONFIG } from './HR'

const MASTER_DATA = {
  vendor: {
    label: "거래처",
    columns: ["상호명", "사업자번호", "대표자", "거래 유형", "담당자", "연락처", "최근 거래"],
    rows: [
      ["한화에어로스페이스",   "856-87-00012", "—",       "발주처",   "박지영", "031-1234-5678", "2026-05-12"],
      ["LIG넥스원",              "127-81-12345", "—",       "발주처",   "정민호", "031-2345-6789", "2026-05-10"],
      ["현대로템",                "121-86-22345", "—",       "발주처",   "최수정", "031-3456-7890", "2026-05-09"],
      ["KAI",                     "615-81-15788", "—",       "발주처",   "한지원", "055-4567-8901", "2026-05-08"],
      ["한화시스템",              "210-81-44567", "—",       "발주처",   "—",      "031-5678-9012", "2026-05-08"],
      ["풍산",                     "203-81-22345", "—",       "발주처",   "—",      "02-6789-0123",  "2026-05-05"],
      ["정밀도금 (주)",            "138-81-77123", "윤지호",  "외주가공", "—",      "031-7890-1234", "2026-05-12"],
      ["(주)한울정밀",             "138-81-22567", "이상호",  "외주가공", "—",      "031-8901-2345", "2026-05-10"],
      ["(주)동아표면처리",         "138-81-44990", "김태호",  "외주가공", "—",      "032-9012-3456", "2026-05-04"],
      ["포스코강판",              "508-86-00001", "—",       "원자재",   "—",      "054-1234-5678", "2026-05-11"],
      ["(주)대원특수강",          "211-81-66547", "—",       "원자재",   "—",      "031-2345-1234", "2026-05-08"],
      ["한국기계연구원",          "314-82-04194", "—",       "시험·인증","—",     "042-3456-7890", "2026-05-09"],
      ["다이아공구",              "138-12-44890", "—",       "공구·소모","—",     "031-4567-8901", "2026-05-07"],
      ["임대인 박OO",              "—",            "박상호",  "임차",     "—",      "010-6789-0123", "2026-05-05"],
    ],
  },
  category: {
    label: "비목",
    columns: ["비목명", "코드", "부가세", "기본 결제수단"],
    grouped: true,
    twoLevel: true,
    groups: [
      { top: "비용", name: "인건비",      desc: "급여·상여·복리후생 등 사람과 관련된 비용", items: [
        ["급여",         "EXP-101", "면세", "계좌이체"],
        ["상여금",       "EXP-102", "면세", "계좌이체"],
        ["복리후생비",   "EXP-103", "면세", "법인카드"],
        ["퇴직급여",     "EXP-104", "면세", "계좌이체"],
      ]},
      { top: "비용", name: "재료비",      desc: "철강·알루미늄·황동 등 원자재 비용", items: [
        ["철강 원자재",   "EXP-201", "10%",  "계좌이체"],
        ["비철금속 (알루미늄·황동)", "EXP-202", "10%", "계좌이체"],
        ["특수강",        "EXP-203", "10%",  "계좌이체"],
        ["부자재 (볼트·너트 등)", "EXP-204", "10%", "법인카드"],
      ]},
      { top: "비용", name: "외주가공비",  desc: "절삭·도금·표면처리·열처리 외주 비용", items: [
        ["정밀가공 외주", "EXP-301", "10%",  "계좌이체"],
        ["표면처리 외주", "EXP-302", "10%",  "계좌이체"],
        ["도금 외주",     "EXP-303", "10%",  "계좌이체"],
        ["열처리 외주",   "EXP-304", "10%",  "계좌이체"],
        ["용접 외주",     "EXP-305", "10%",  "계좌이체"],
      ]},
      { top: "비용", name: "공구·소모품", desc: "절삭공구·측정구·생산소모품", items: [
        ["공구비",        "EXP-401", "10%",  "법인카드"],
        ["측정공구비",    "EXP-402", "10%",  "법인카드"],
        ["소모품비",      "EXP-403", "10%",  "법인카드"],
        ["윤활유·절삭유", "EXP-404", "10%",  "법인카드"],
      ]},
      { top: "비용", name: "시험·인증비", desc: "검사성적서·시험성적서·KS·방산인증", items: [
        ["시험검사비",     "EXP-501", "10%",  "계좌이체"],
        ["검사성적서 발급", "EXP-502", "10%", "계좌이체"],
        ["방산인증 수수료", "EXP-503", "면세", "계좌이체"],
        ["KS 인증 수수료",  "EXP-504", "면세", "계좌이체"],
      ]},
      { top: "비용", name: "운영비",      desc: "공장 임차·전력·통신·운반 등 고정 비용", items: [
        ["임차료",       "EXP-601", "10%",  "계좌이체"],
        ["관리비",       "EXP-602", "10%",  "계좌이체"],
        ["통신비",       "EXP-603", "10%",  "계좌이체"],
        ["전력비",       "EXP-604", "10%",  "계좌이체"],
        ["수도광열비",   "EXP-605", "10%",  "계좌이체"],
        ["운반비",       "EXP-606", "10%",  "계좌이체"],
      ]},
      { top: "비용", name: "여비·교통비", desc: "출장·교통·식대 등", items: [
        ["식대",         "EXP-701", "면세", "법인카드"],
        ["교통비",       "EXP-702", "면세", "법인카드"],
        ["출장비",       "EXP-703", "면세", "법인카드"],
      ]},
      { top: "비용", name: "안전·환경",   desc: "산업안전·환경 관련 비용", items: [
        ["안전관리비",   "EXP-801", "10%",  "계좌이체"],
        ["보호구·안전용품", "EXP-802", "10%", "법인카드"],
        ["환경규제 수수료", "EXP-803", "면세", "계좌이체"],
      ]},
      { top: "비용", name: "세금과공과",  desc: "세금·공과금·수수료 등", items: [
        ["세금과공과",   "EXP-901", "면세", "계좌이체"],
        ["수수료",       "EXP-902", "10%",  "계좌이체"],
        ["지급수수료",   "EXP-903", "10%",  "계좌이체"],
      ]},
      { top: "수익", name: "납품수익",    desc: "발주처 납품 대금 (선급금·기성고·잔금 등)", items: [
        ["선급금",       "INC-101", "10%",  "—"],
        ["기성고",       "INC-102", "10%",  "—"],
        ["검수 후 결제", "INC-103", "10%",  "—"],
        ["납품대금",     "INC-104", "10%",  "—"],
        ["잔금",         "INC-105", "10%",  "—"],
      ]},
      { top: "수익", name: "기타수익",    desc: "용역수익·환급금·잡수익·이자수익 등", items: [
        ["용역수익",     "INC-201", "10%",  "—"],
        ["환급금",       "INC-202", "—",    "—"],
        ["잡수익",       "INC-203", "—",    "—"],
        ["이자수익",     "INC-204", "면세", "—"],
      ]},
    ],
    get rows() {
      return this.groups.flatMap(g => g.items);
    },
  },
  account: {
    label: "계좌 / 카드",
    columns: ["유형", "은행/카드사", "계좌·카드번호", "별칭", "잔액"],
    rows: [
      ["계좌", "기업은행",   "***-****-123-01", "주거래 (납품대금 수금)", "184,500,000"],
      ["계좌", "신한은행",   "***-***-456-02",  "발주처 별 수금 전용",    "76,200,000"],
      ["계좌", "국민은행",   "***-**-***-789",  "예비 (정부지원금)",      "12,800,000"],
      ["카드", "BC 법인카드","*1234-****-7821", "법인카드 #1 (영업)",     "—"],
      ["카드", "현대 법인카드","*5678-****-3456","법인카드 #2 (생산)",    "—"],
    ],
  },
  evidenceType: {
    label: "증빙유형",
    columns: ["유형명", "설명", "필수 입력", "기본 첨부"],
    rows: [
      ["발주서",       "발주처가 발행한 PO",          "발주번호/금액",       "PDF"],
      ["세금계산서",   "전자세금계산서 PDF",          "공급가액/부가세",     "세금계산서 PDF"],
      ["거래명세서",   "납품 시 첨부하는 명세서",      "품목/수량",          "PDF"],
      ["검사성적서",   "초도검사·중간검사 결과",       "검사 항목/판정",     "PDF"],
      ["시험성적서",   "공인기관 시험 결과 (KOLAS)",    "시험 항목/수치",     "PDF"],
      ["납품확인서",   "발주처가 발행한 검수 확인",     "납품 수량/일자",     "PDF"],
      ["영수증",       "현금/카드 영수증",             "금액",               "이미지/PDF"],
      ["카드영수증",   "법인카드 결제 영수증",         "금액",               "이미지/PDF"],
      ["통장내역",     "이체 확인용 통장 스크린샷",     "금액/일자",          "이미지/PDF"],
      ["기타",         "그 외 증빙",                  "—",                   "파일"],
    ],
  },
  user: {
    label: "사용자 / 결재선",
    columns: ["이름", "이메일", "직위", "권한", "결재 순번"],
    grouped: true,
    twoLevel: false,
    groups: [
      { name: "대표",     desc: "최종 결재자",       items: [
        ["정대표", "ceo@hanshin.co.kr",   "대표이사", "관리자",      "최종 승인"],
      ]},
      { name: "관리지원본부", desc: "회계·구매·결의 검토", items: [
        ["정수민", "sumin@hanshin.co.kr", "팀장",     "관리자",      "검토"],
        ["한경리", "kyung@hanshin.co.kr", "사원",     "일반 사용자", "작성"],
      ]},
      { name: "영업본부", desc: "발주처 영업·계약 PM", items: [
        ["이지원", "jiwon@hanshin.co.kr", "과장",     "일반 사용자", "검토 (영업 한정)"],
      ]},
      { name: "생산본부", desc: "공장 운영·품질 관리", items: [
        ["박서연", "seoyeon@hanshin.co.kr", "대리",   "일반 사용자", "—"],
        ["최민호", "minho@hanshin.co.kr", "사원",     "일반 사용자", "—"],
      ]},
    ],
    get rows() {
      return this.groups.flatMap(g => g.items);
    },
  },
  department: {
    label: "부서",
    columns: ["부서명", "상위 부서", "부서장", "구성원", "상태"],
    rows: [
      ["대표",         "—",             "정대표", "1명", "활성"],
      ["관리지원본부", "대표",          "정수민", "2명", "활성"],
      ["└ 재무팀",     "관리지원본부", "정수민", "2명", "활성"],
      ["└ 구매팀",     "관리지원본부", "—",      "0명", "예정"],
      ["영업본부",     "대표",          "이지원", "1명", "활성"],
      ["생산본부",     "대표",          "—",      "2명", "활성"],
      ["└ 가공팀",     "생산본부",     "박서연", "1명", "활성"],
      ["└ 품질팀",     "생산본부",     "최민호", "1명", "활성"],
      ["연구개발팀",   "대표",          "—",      "0명", "예정"],
    ],
  },
  position: {
    label: "직위",
    columns: ["직위명", "직급 단계", "결재 권한", "비고"],
    rows: [
      ["대표이사", "1",  "최종 승인", "최종 결재자"],
      ["이사",     "2",  "승인",      "—"],
      ["부장",     "3",  "승인",      "—"],
      ["팀장",     "4",  "검토",      "—"],
      ["과장",     "5",  "검토",      "—"],
      ["대리",     "6",  "—",         "—"],
      ["주임",     "7",  "작성",      "—"],
      ["사원",     "8",  "작성",      "—"],
    ],
  },
  employee: {
    label: "직원",
    columns: ["사번", "이름", "직위", "입사일", "재직상태", "퇴사일", "급여 계좌"],
    grouped: true,
    twoLevel: false,
    groups: [
      { name: "대표",   desc: "대표이사",            items: [
        ["E2018-001", "정대표", "대표이사", "2018-03-15", "재직", "—",         "기업은행 *1234"],
      ]},
      { name: "재무팀", desc: "회계·결의 담당",      items: [
        ["E2020-007", "정수민", "팀장",     "2020-04-02", "재직", "—",         "신한은행 *5021"],
        ["E2024-014", "한경리", "사원",     "2024-01-08", "재직", "—",         "기업은행 *7732"],
      ]},
      { name: "기획팀", desc: "PM·기획",             items: [
        ["E2022-003", "이지원", "과장",     "2022-06-20", "재직", "—",         "국민은행 *3344"],
        ["E2025-002", "윤서연", "사원",     "2025-02-03", "수습", "—",         "—"],
      ]},
      { name: "개발팀", desc: "개발·기술",           items: [
        ["E2021-005", "박서연", "대리",     "2021-09-13", "재직", "—",         "신한은행 *8810"],
        ["E2023-011", "최민호", "사원",     "2023-11-20", "재직", "—",         "기업은행 *4503"],
      ]},
      { name: "퇴사자", desc: "퇴사한 직원 (참고)", items: [
        ["E2019-002", "김OO",   "대리",     "2019-07-01", "퇴사", "2025-12-31", "기업은행 *0099"],
      ]},
    ],
    get rows() {
      return this.groups.flatMap(g => g.items);
    },
  },
  company: {
    label: "회사 정보",
    columns: ["항목", "값"],
    rows: [
      ["회사명",          "주식회사 한신정밀"],
      ["사업자등록번호",  "120-81-99887"],
      ["대표자",          "정대표"],
      ["업태/종목",       "제조업 / 정밀가공·방산부품"],
      ["주요 인증",       "방산물자 지정업체 · ISO 9001 · KS Q ISO 9001"],
      ["주소",            "경기도 안산시 시화공단 OO로 24"],
      ["연락처",          "031-1234-5678"],
      ["이메일",          "contact@hanshin.co.kr"],
      ["회계 연도 시작",  "매년 1월 1일"],
      ["부가세 신고 주기","분기"],
    ],
  },
  template: {
    label: "문서 양식",
    columns: ["양식명", "유형", "설명", "최근 수정"],
    rows: [
      ["기본 지출결의서",   "결의서", "3단 결재선, 첨부 증빙 자동 인용", "2026-04-21"],
      ["대표 단독 결의서",  "결의서", "대표 단독 결재용 간이 양식",       "2026-03-10"],
      ["기본 청구서",       "청구서", "기본 부가세 포함 청구서",          "2026-02-05"],
    ],
  },
  payroll: {
    label: "급여 기준",
    custom: true,
  },
};

const MASTER_TABS = [
  { id: "vendor",       label: "거래처" },
  { id: "category",     label: "비목" },
  { id: "account",      label: "계좌/카드" },
  { id: "evidenceType", label: "증빙유형" },
  { id: "department",   label: "부서" },
  { id: "position",     label: "직위" },
  { id: "user",         label: "사용자/결재선" },
  { id: "payroll",      label: "급여 기준" },
  { id: "company",      label: "회사 정보" },
  { id: "template",     label: "문서 양식" },
];

export const MasterScreen = () => {
  const toast = useToast();
  const [tab, setTab] = useState("vendor");
  const [q, setQ] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const data = MASTER_DATA[tab];
  const rows = data.rows ? data.rows.filter(r => !q || r.some(c => String(c).toLowerCase().includes(q.toLowerCase()))) : [];

  const toggleGroup = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">기준정보</div>
          <div className="page-sub">거래처·계약·비목·계좌·결재선 등 회사의 기본 정보를 등록하고 관리하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          {!data.custom && (
            <>
              <button className="btn" onClick={() => toast.push(`${data.label} 양식을 내려받았어요`)}><Icon.Download/> <span className="btn-label-hide">양식 다운로드</span></button>
              <button className="btn" onClick={() => toast.push(`${data.label} 일괄 업로드 창을 열었어요`)}><Icon.Excel/> <span className="btn-label-hide">일괄 업로드</span></button>
              <button className="btn primary" onClick={() => setDrawer("new")}><Icon.Plus/> {data.label} 등록</button>
            </>
          )}
        </div>
      </div>

      <Spacer h={20}/>

      <div className="master-layout" style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, alignItems: "start" }}>
        {/* Sub-nav */}
        <div className="card" style={{ padding: 8 }}>
          {MASTER_TABS.map(t => {
            const active = tab === t.id;
            const md = MASTER_DATA[t.id];
            let count = "";
            if (md.custom) {
              count = "";
            } else if (md.grouped) {
              count = md.groups.reduce((a, g) => a + g.items.length, 0);
            } else {
              count = md.rows.length;
            }
            return (
              <button key={t.id}
                className={`nav-item ${active ? "active" : ""}`}
                style={{ width: "100%", justifyContent: "flex-start" }}
                onClick={() => { setTab(t.id); setQ(""); }}>
                <span>{t.label}</span>
                {count !== "" && <span className="nav-count" style={{ marginLeft: "auto" }}>{count}</span>}
              </button>
            );
          })}
        </div>

        {/* Right panel */}
        <div className="card" style={{ overflow: "hidden" }}>
          {data.custom ? (
            <PayrollConfigPanel/>
          ) : (
            <>
              <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div className="section-title">{data.label}</div>
                  <div className="section-sub">
                    {data.grouped
                      ? `${data.groups.length}개 대분류 · 총 ${data.rows.length}건`
                      : `총 ${data.rows.length}건 등록됨`}
                  </div>
                </div>
                <div className="ml-auto row gap-8" style={{ flexWrap: "wrap" }}>
                  <div className="search" style={{ margin: 0, width: 200, padding: "6px 10px" }}>
                    <Icon.Search size={14}/>
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder={`${data.label} 검색`}/>
                  </div>
                  <button className="btn"><Icon.Filter/> 필터</button>
                </div>
              </div>

              <div className="table-scroll">
                {data.grouped ? (
                  <GroupedTable
                    data={data}
                    q={q}
                    collapsed={collapsed}
                    toggleGroup={toggleGroup}
                    onEdit={(g, idx) => setDrawer({ group: g.name, item: idx })}
                    onDelete={(name) => toast.push(`${name} 삭제됨`)}
                  />
                ) : (
                  <FlatTable
                    data={data}
                    rows={rows}
                    onEdit={(i) => setDrawer(i)}
                    onDelete={(name) => toast.push(`${name} 삭제됨`)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {!data.custom && (
        <MasterDrawer
          open={drawer !== null}
          mode={drawer === "new" ? "new" : "edit"}
          category={data}
          rowIndex={typeof drawer === "number" ? drawer : null}
          groupedSel={drawer && typeof drawer === "object" ? drawer : null}
          onClose={() => setDrawer(null)}
          onSave={() => { setDrawer(null); toast.push(drawer === "new" ? `새 ${data.label}을(를) 등록했어요` : `${data.label} 정보를 저장했어요`); }}
        />
      )}
    </div>
  );
};

const FlatTable = ({ data, rows, onEdit, onDelete }) => (
  <table className="table">
    <thead>
      <tr>
        {data.columns.map(c => <th key={c}>{c}</th>)}
        <th style={{ width: 80 }}></th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r, i) => (
        <tr key={i} style={{ cursor: "pointer" }} onClick={() => onEdit(i)}>
          {r.map((cell, j) => {
            const colName = data.columns[j];
            if (colName === "상태") return <td key={j}><StatusBadge status={cell}/></td>;
            if (j === 0) return <td key={j} className="fw-600">{cell}</td>;
            return <td key={j} className={/번호|금액|잔액|연락처/.test(colName) ? "num text-sm" : "text-sm"} style={{ color: cell === "—" ? "var(--muted-2)" : undefined }}>{cell}</td>;
          })}
          <td>
            <div className="row gap-4">
              <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(i); }}>편집</button>
              <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onDelete(r[0]); }}><Icon.Close size={14}/></button>
            </div>
          </td>
        </tr>
      ))}
      {rows.length === 0 && (
        <tr><td colSpan={data.columns.length + 1} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)" }}>
          검색 결과가 없어요.
        </td></tr>
      )}
    </tbody>
  </table>
);

const GroupedTable = ({ data, q, collapsed, toggleGroup, onEdit, onDelete }) => {
  const filterMatch = (r, gName, topName) =>
    !q ||
    r.some(c => String(c).toLowerCase().includes(q.toLowerCase())) ||
    gName.includes(q) ||
    (topName && topName.includes(q));

  if (data.twoLevel) {
    const tops = [...new Set(data.groups.map(g => g.top))];
    return (
      <div>
        {tops.map((top) => {
          const subGroups = data.groups.filter(g => g.top === top);
          const totalItems = subGroups.reduce((a, g) => a + g.items.length, 0);
          const topKey = `top:${top}`;
          const isTopOpen = !collapsed[topKey];
          if (q) {
            const anyMatch = subGroups.some(g =>
              g.items.some(r => filterMatch(r, g.name, top))
            );
            if (!anyMatch) return null;
          }
          return (
            <div key={top}>
              <button onClick={() => toggleGroup(topKey)}
                style={{
                  width: "100%", textAlign: "left",
                  padding: "16px 18px",
                  background: top === "수익" ? "#F0F8F3" : "#FFF8EE",
                  borderBottom: "1px solid var(--line)", borderTop: "1px solid var(--line)",
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                  fontFamily: "inherit",
                }}>
                <span style={{ transform: isTopOpen ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-flex", color: "var(--muted)" }}>
                  <Icon.Right size={14}/>
                </span>
                <span className={`badge ${top === "수익" ? "pos" : "warn"}`} style={{ padding: "2px 10px" }}>{top}</span>
                <span className="fw-700" style={{ fontSize: 14 }}>큰 분류 · {top === "수익" ? "회사로 들어오는 돈" : "회사에서 나가는 돈"}</span>
                <span className="ml-auto text-xs text-muted2">{subGroups.length}개 중분류 · {totalItems}개 비목</span>
              </button>
              {isTopOpen && subGroups.map((g) => {
                const groupKey = `mid:${g.name}`;
                const isMidOpen = !collapsed[groupKey];
                const filteredItems = g.items.filter(r => filterMatch(r, g.name, top));
                if (q && filteredItems.length === 0) return null;
                return (
                  <div key={g.name}>
                    <button onClick={() => toggleGroup(groupKey)}
                      style={{
                        width: "100%", textAlign: "left",
                        padding: "12px 18px 12px 42px",
                        background: "var(--surface-2)", border: 0,
                        borderBottom: "1px solid var(--line)",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                        fontFamily: "inherit",
                      }}>
                      <span style={{ transform: isMidOpen ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-flex", color: "var(--muted-2)" }}>
                        <Icon.Right size={12}/>
                      </span>
                      <span className="fw-600" style={{ fontSize: 13 }}>{g.name}</span>
                      <span className="text-xs text-muted2" style={{ marginLeft: 4 }}>· {g.desc}</span>
                      <span className="ml-auto text-xs text-muted2 num">{g.items.length}건</span>
                    </button>
                    {isMidOpen && (
                      <table className="table" style={{ borderBottom: "1px solid var(--line)" }}>
                        <thead>
                          <tr>
                            {data.columns.map(c => <th key={c} style={{ background: "#fff", paddingLeft: c === data.columns[0] ? 66 : undefined }}>{c}</th>)}
                            <th style={{ width: 80, background: "#fff" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredItems.map((r) => {
                            const idx = g.items.indexOf(r);
                            return (
                              <tr key={idx} style={{ cursor: "pointer" }} onClick={() => onEdit(g, idx)}>
                                {r.map((cell, j) => {
                                  const colName = data.columns[j];
                                  if (j === 0) return <td key={j} className="fw-600" style={{ paddingLeft: 66 }}>{cell}</td>;
                                  if (colName === "부가세") {
                                    const tone = cell === "면세" || cell === "—" ? "outline" : "brand";
                                    return <td key={j}><span className={`badge ${tone}`}>{cell}</span></td>;
                                  }
                                  return <td key={j} className={/코드/.test(colName) ? "num text-sm" : "text-sm"} style={{ color: cell === "—" ? "var(--muted-2)" : undefined }}>{cell}</td>;
                                })}
                                <td>
                                  <div className="row gap-4">
                                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(g, idx); }}>편집</button>
                                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onDelete(r[0]); }}><Icon.Close size={14}/></button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {data.groups.map((g) => {
        const filtered = g.items.filter(r => filterMatch(r, g.name));
        if (q && filtered.length === 0) return null;
        const isOpen = !collapsed[g.name];
        return (
          <div key={g.name} style={{ borderTop: "1px solid var(--line)" }}>
            <button
              onClick={() => toggleGroup(g.name)}
              style={{
                width: "100%", textAlign: "left", padding: "14px 18px",
                background: "var(--surface-2)", border: 0,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                fontFamily: "inherit",
              }}>
              <span style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-flex", color: "var(--muted)" }}>
                <Icon.Right size={14}/>
              </span>
              <span className="fw-700">{g.name}</span>
              <span className="text-xs text-muted" style={{ marginLeft: 4 }}>· {g.desc}</span>
              <span className="ml-auto text-xs text-muted2">{g.items.length}건</span>
            </button>
            {isOpen && (
              <table className="table">
                <thead>
                  <tr>
                    {data.columns.map(c => <th key={c} style={{ background: "#fff" }}>{c}</th>)}
                    <th style={{ width: 80, background: "#fff" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const idx = g.items.indexOf(r);
                    return (
                      <tr key={idx} style={{ cursor: "pointer" }} onClick={() => onEdit(g, idx)}>
                        {r.map((cell, j) => {
                          const colName = data.columns[j];
                          if (j === 0) return <td key={j} className="fw-600" style={{ paddingLeft: 44 }}>{cell}</td>;
                          if (colName === "권한") return <td key={j}><span className={`badge ${cell === "관리자" ? "ink" : "outline"}`}>{cell}</span></td>;
                          if (colName === "결재 순번" && cell !== "—") return <td key={j}><span className="badge brand">{cell}</span></td>;
                          if (colName === "재직상태") return <td key={j}><StatusBadge status={cell}/></td>;
                          if (colName === "사번") return <td key={j} className="num text-sm" style={{ color: "var(--muted)" }}>{cell}</td>;
                          if (/입사일|퇴사일/.test(colName)) return <td key={j} className="num text-sm" style={{ color: cell === "—" ? "var(--muted-2)" : "var(--muted)" }}>{cell}</td>;
                          return <td key={j} className="text-sm" style={{ color: cell === "—" ? "var(--muted-2)" : undefined }}>{cell}</td>;
                        })}
                        <td>
                          <div className="row gap-4">
                            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(g, idx); }}>편집</button>
                            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onDelete(r[0]); }}><Icon.Close size={14}/></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
};

const MasterDrawer = ({ open, mode, category, rowIndex, groupedSel, onClose, onSave }) => {
  if (!open) return null;
  let row = null;
  let initialGroup = null;
  if (groupedSel) {
    const g = category.groups.find(gr => gr.name === groupedSel.group);
    row = g?.items[groupedSel.item];
    initialGroup = groupedSel.group;
  } else if (rowIndex != null) {
    row = category.rows[rowIndex];
  }
  const isEdit = mode === "edit";
  const title = mode === "new" ? `새 ${category.label} 등록` : `${category.label} 정보 편집`;

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose}/>
      <aside className="drawer open" role="dialog" aria-label={title} style={{ width: "min(520px, 100vw)" }}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>{title}</div>
            <div className="text-xs text-muted">
              {mode === "new"
                ? "필수 항목만 채우면 바로 등록할 수 있어요."
                : "변경한 내용은 즉시 반영됩니다."}
            </div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body">
          <div className="col gap-16">
            {category.grouped && (
              <div>
                <label className="label">대분류 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {category.groups.map(g => (
                    <button key={g.name} className={`chip ${initialGroup === g.name ? "active" : ""}`}>
                      {g.name}
                    </button>
                  ))}
                  <button className="chip"><Icon.Plus size={12}/> 새 대분류</button>
                </div>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>대분류는 결의서·세무사 자료에서 그룹 헤더로 사용돼요.</div>
              </div>
            )}

            {category.columns.map((c, i) => {
              const initial = row ? row[i] : "";
              const isStatus = c === "상태";
              const isLong = /설명|주소/.test(c);

              if (c === "부가세") {
                return (
                  <div key={c}>
                    <label className="label">{c}</label>
                    <div className="row gap-6">
                      {["10%", "면세", "—"].map(s => (
                        <button key={s} className={`chip ${initial === s ? "active" : ""}`}>{s}</button>
                      ))}
                    </div>
                  </div>
                );
              }
              if (c === "기본 결제수단") {
                return (
                  <div key={c}>
                    <label className="label">{c}</label>
                    <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                      {["계좌이체", "법인카드", "개인카드", "현금", "—"].map(s => (
                        <button key={s} className={`chip ${initial === s ? "active" : ""}`}>{s}</button>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <div key={c}>
                  <label className="label">
                    {c} {i === 0 ? <span style={{ color: "var(--neg-ink)" }}>*</span> : null}
                  </label>
                  {isStatus ? (
                    <div className="row gap-6">
                      {["진행중", "보류", "완료"].map(s => (
                        <button key={s} className={`chip ${initial === s ? "active" : ""}`}>{s}</button>
                      ))}
                    </div>
                  ) : isLong ? (
                    <textarea className="input" rows={2} defaultValue={initial} style={{ resize: "vertical", fontFamily: "inherit" }}/>
                  ) : (
                    <input className="input" defaultValue={initial} placeholder={`${c}을(를) 입력하세요`}/>
                  )}
                </div>
              );
            })}

            {category.label === "거래처" && (
              <div>
                <label className="label">메모</label>
                <textarea className="input" rows={2} placeholder="거래처에 대한 메모를 자유롭게 적어주세요" style={{ resize: "vertical", fontFamily: "inherit" }}/>
              </div>
            )}

            {category.label === "비목" && (
              <div className="alert-row" style={{ background: "var(--brand-soft)", borderColor: "transparent" }}>
                <Icon.Sparkle/>
                <div>
                  <div className="lead">비목은 결의서·세무 자료에 그대로 표기돼요.</div>
                  <div className="body">사용 중인 비목은 삭제 대신 '비활성화'를 권장합니다.</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="drawer-foot">
          {isEdit ? (
            <button className="btn" onClick={onClose} style={{ color: "var(--neg-ink)" }}>이 행 삭제</button>
          ) : (
            <button className="btn" onClick={onClose}>취소</button>
          )}
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={onClose}>닫기</button>
            <button className="btn primary" onClick={onSave}><Icon.Check size={14}/> {mode === "new" ? "등록하기" : "저장하기"}</button>
          </div>
        </div>
      </aside>
    </>
  );
};

const PayrollConfigPanel = () => {
  const toast = useToast();
  const cfg = PAYROLL_CONFIG;
  const rows = [
    { id: "pension",  ...cfg.rates.pension  },
    { id: "health",   ...cfg.rates.health   },
    { id: "care",     ...cfg.rates.care     },
    { id: "jobless",  ...cfg.rates.jobless  },
    { id: "accident", ...cfg.rates.accident },
  ];

  return (
    <div>
      <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="section-title">급여 기준 · {cfg.effectiveYear}년</div>
          <div className="section-sub">매년 1월 4대보험 요율 발표 후 갱신해주세요. 인사관리 화면의 모든 계산이 여기 값을 따라갑니다.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("작년 요율과 비교했어요")}>작년과 비교</button>
          <button className="btn primary" onClick={() => toast.push("요율이 저장되었어요")}><Icon.Check size={14}/> 저장</button>
        </div>
      </div>

      <div style={{ padding: 22 }}>
        <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 10 }}>4대보험 요율 (%)</div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>항목</th>
                <th>관할 기관</th>
                <th>산정 기준</th>
                <th className="num-right" style={{ width: 110 }}>근로자</th>
                <th className="num-right" style={{ width: 110 }}>회사</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="fw-700">{r.label}</td>
                  <td className="text-sm text-muted">{r.agency}</td>
                  <td className="text-sm">
                    {r.base}
                    {r.note && <div className="text-xs text-muted2">{r.note}</div>}
                  </td>
                  <td><RateInput value={r.employee}/></td>
                  <td><RateInput value={r.employer}/></td>
                  <td>
                    <button className="btn ghost sm" onClick={() => toast.push(`${r.label} 변경 이력을 열었어요`)}><Icon.Clock size={14}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", margin: "26px 0 10px" }}>비과세 한도 (월)</div>
        <table className="table">
          <thead>
            <tr><th>항목</th><th>설명</th><th className="num-right" style={{ width: 180 }}>한도 (원)</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="fw-700">식대</td>
              <td className="text-sm text-muted">월 20만원까지 비과세 (2024년 개정)</td>
              <td><MoneyConfig defaultValue={cfg.taxFree.meal}/></td>
            </tr>
            <tr>
              <td className="fw-700">자가운전 보조금</td>
              <td className="text-sm text-muted">본인 차량 업무 사용 시 월 20만원까지 비과세</td>
              <td><MoneyConfig defaultValue={cfg.taxFree.vehicle}/></td>
            </tr>
          </tbody>
        </table>

        <div className="alert-row" style={{ marginTop: 20, background: "var(--brand-soft)", borderColor: "transparent" }}>
          <Icon.Sparkle/>
          <div>
            <div className="lead">요율이 바뀌면 다음 달 급여부터 적용됩니다.</div>
            <div className="body">이미 마감된 월의 명세는 그대로 보존되며, 변경 이력에서 언제 어떤 값으로 바뀌었는지 추적할 수 있어요.</div>
          </div>
        </div>
      </div>
    </div>
  );
};

const RateInput = ({ value }) => {
  const [v, setV] = useState(value);
  return (
    <div style={{ position: "relative" }}>
      <input className="input num fw-700" style={{ paddingRight: 28, padding: "8px 28px 8px 10px", fontSize: 13 }}
        value={v}
        onChange={e => setV(e.target.value)}/>
      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 11 }}>%</span>
    </div>
  );
};

const MoneyConfig = ({ defaultValue }) => {
  const [v, setV] = useState(defaultValue);
  return (
    <div style={{ position: "relative" }}>
      <input className="input num fw-700 num-right" style={{ padding: "8px 32px 8px 10px", fontSize: 13 }}
        value={fmtNum(v)}
        onChange={e => setV(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}/>
      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 11 }}>원</span>
    </div>
  );
};
