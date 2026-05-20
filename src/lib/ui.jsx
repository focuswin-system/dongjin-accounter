import { useState, useEffect, useMemo, useRef, createContext, useContext, cloneElement } from 'react'

/* ── Formatters ── */
export const fmtKRW = (n, opts = {}) => {
  if (n == null || isNaN(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n).toLocaleString("ko-KR");
  return sign + v + (opts.suffix ?? "원");
};
export const fmtNum = (n) => (n ?? 0).toLocaleString("ko-KR");
export const fmtDate = (s) => s;

/* ── 기간 프리셋 ── */
export const PERIOD_PRESETS = [
  { id: "all",     label: "전체" },
  { id: "month",   label: "이번 달" },
  { id: "last",    label: "지난 달" },
  { id: "quarter", label: "이번 분기" },
  { id: "year",    label: "올해" },
  { id: "custom",  label: "직접 입력" },
];

export const periodToRange = (id) => {
  if (!id || id === "all") return null;
  const d = new Date(), y = d.getFullYear(), m = d.getMonth(); // m: 0-indexed
  if (id === "month") {
    const ms = String(m + 1).padStart(2, "0");
    return { from: `${y}-${ms}-01`, to: `${y}-${ms}-31` };
  }
  if (id === "last") {
    const lm = m === 0 ? 12 : m, ly = m === 0 ? y - 1 : y;
    const ls = String(lm).padStart(2, "0");
    return { from: `${ly}-${ls}-01`, to: `${ly}-${ls}-31` };
  }
  if (id === "quarter") {
    const qs = Math.floor(m / 3) * 3 + 1, qe = qs + 2;
    return { from: `${y}-${String(qs).padStart(2,"0")}-01`, to: `${y}-${String(qe).padStart(2,"0")}-31` };
  }
  if (id === "year") return { from: `${y}-01-01`, to: `${y}-12-31` };
  return null;
};

export const inPeriod = (date, id, custom) => {
  if (id === "custom") {
    return (!custom?.from || date >= custom.from) && (!custom?.to || date <= custom.to);
  }
  const r = periodToRange(id);
  return !r || (date >= r.from && date <= r.to);
};

export const periodRangeLabel = (id, custom) => {
  if (id === "custom") {
    const f = custom?.from?.replace(/-/g, ".") || "";
    const t = custom?.to?.replace(/-/g, ".") || "";
    if (!f && !t) return null;
    return `${f || "…"} ~ ${t || "…"}`;
  }
  if (!id || id === "all") return null;
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const lastDay = (yr, mo) => new Date(yr, mo, 0).getDate();
  const fmt = (yr, mo, day) => `${yr}.${String(mo).padStart(2,"0")}.${String(day).padStart(2,"0")}`;
  if (id === "month")   return `${fmt(y,m+1,1)} ~ ${fmt(y,m+1,lastDay(y,m+1))}`;
  if (id === "last")    { const lm=m||12, ly=m?y:y-1; return `${fmt(ly,lm,1)} ~ ${fmt(ly,lm,lastDay(ly,lm))}`; }
  if (id === "quarter") { const qs=Math.floor(m/3)*3+1, qe=qs+2; return `${fmt(y,qs,1)} ~ ${fmt(y,qe,lastDay(y,qe))}`; }
  if (id === "year")    return `${fmt(y,1,1)} ~ ${fmt(y,12,31)}`;
  return null;
};

/* ── FilterSelect: 필터용 검색 가능 드롭다운 ── */
export const FilterSelect = ({ value, onChange, options, placeholder = "전체" }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) { setQ(""); return; }
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const matched = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className={`btn sm ${value ? "active" : ""}`}
        onClick={() => setOpen(s => !s)}
        style={{ minWidth: 130, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
          {value || placeholder}
        </span>
        <I d={<><polyline points="6 9 12 15 18 9"/></>} size={12} style={{ flexShrink: 0 }}/>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
          background: "#fff", border: "1px solid var(--line)", borderRadius: 10,
          boxShadow: "0 4px 20px rgba(0,0,0,0.09)", minWidth: 190, overflow: "hidden",
        }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
            <input autoFocus className="input" style={{ height: 32, fontSize: 13 }}
              value={q} onChange={e => setQ(e.target.value)} placeholder="검색..."/>
          </div>
          <div style={{ maxHeight: 210, overflowY: "auto" }}>
            <button onClick={() => { onChange(null); setOpen(false); }}
              style={{ width: "100%", textAlign: "left", padding: "8px 14px", border: 0,
                background: !value ? "var(--surface-2)" : "transparent",
                cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                fontWeight: 600, color: "var(--muted)" }}>전체</button>
            {matched.map(o => (
              <button key={o} onClick={() => { onChange(o); setOpen(false); }}
                onMouseEnter={e => { if (value !== o) e.currentTarget.style.background = "var(--surface-2)"; }}
                onMouseLeave={e => { if (value !== o) e.currentTarget.style.background = "transparent"; }}
                style={{ width: "100%", textAlign: "left", padding: "8px 14px", border: 0,
                  background: value === o ? "var(--surface-2)" : "transparent",
                  cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                  fontWeight: value === o ? 700 : 400, color: "var(--ink)" }}>
                {o}
              </button>
            ))}
            {matched.length === 0 && (
              <div style={{ padding: "12px 14px", color: "var(--muted-2)", fontSize: 13 }}>검색 결과 없음</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ── HelpPopover: 페이지별 컨텍스트 도움말 ── */
export const HelpPopover = ({ title, items }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        onClick={() => setOpen(s => !s)}
        title="도움말"
        style={{ color: open ? "var(--brand)" : "var(--muted-2)", transition: "color .15s" }}>
        <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
          <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 300,
          background: "#fff", border: "1px solid var(--line)", borderRadius: 12,
          boxShadow: "0 6px 24px rgba(0,0,0,0.09)", width: 292, padding: "16px 18px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <circle cx="12" cy="17" r="0.6" fill="var(--brand)" stroke="none"/>
            </svg>
            <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: "-0.01em" }}>{title}</span>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((item, i) => (
              <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
                <span style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2, fontWeight: 700 }}>·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/* ── Icons ── */
export const I = ({ d, size = 18, fill = "none", className = "", stroke = "currentColor", style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke}
       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
    {d}
  </svg>
);

export const Icon = {
  Home:    (p) => <I {...p} d={<><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></>} />,
  In:      (p) => <I {...p} d={<><path d="M12 4v12"/><path d="M6 10l6 6 6-6"/><path d="M4 20h16"/></>} />,
  Out:     (p) => <I {...p} d={<><path d="M12 20V8"/><path d="M6 14l6-6 6 6"/><path d="M4 4h16"/></>} />,
  Recv:    (p) => <I {...p} d={<><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>} />,
  Pay:     (p) => <I {...p} d={<><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M14 15h3"/></>} />,
  Doc:     (p) => <I {...p} d={<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></>} />,
  Sign:    (p) => <I {...p} d={<><path d="M4 19h16"/><path d="M4 15l8-8 4 4-8 8H4z"/></>} />,
  Receipt: (p) => <I {...p} d={<><path d="M5 3v18l3-2 3 2 3-2 3 2 3-2V3z"/><path d="M9 8h8"/><path d="M9 12h8"/><path d="M9 16h4"/></>} />,
  Chart:   (p) => <I {...p} d={<><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-8"/><path d="M22 20H2"/></>} />,
  Cog:     (p) => <I {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></>} />,
  Book:    (p) => <I {...p} d={<><path d="M4 4.5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2z"/><path d="M19 19.5v3H6a2 2 0 0 1-2-2"/><path d="M8 7h7M8 11h7"/></>} />,
  Search:  (p) => <I {...p} d={<><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>} />,
  Plus:    (p) => <I {...p} d={<><path d="M12 5v14M5 12h14"/></>} />,
  Bell:    (p) => <I {...p} d={<><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z"/><path d="M10 20a2 2 0 0 0 4 0"/></>} />,
  Filter:  (p) => <I {...p} d={<><path d="M3 5h18l-7 9v6l-4-2v-4z"/></>} />,
  Down:    (p) => <I {...p} d={<><path d="M6 9l6 6 6-6"/></>} />,
  Up:      (p) => <I {...p} d={<><path d="M6 15l6-6 6 6"/></>} />,
  Right:   (p) => <I {...p} d={<><path d="M9 6l6 6-6 6"/></>} />,
  Left:    (p) => <I {...p} d={<><path d="M15 6l-6 6 6 6"/></>} />,
  Close:   (p) => <I {...p} d={<><path d="M6 6l12 12M18 6L6 18"/></>} />,
  Check:   (p) => <I {...p} d={<><path d="M5 12l5 5 9-11"/></>} />,
  Warn:    (p) => <I {...p} d={<><path d="M12 3l10 18H2z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.6" fill="currentColor" stroke="none"/></>} />,
  Calendar:(p) => <I {...p} d={<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></>} />,
  Excel:   (p) => <I {...p} d={<><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 8h20M2 13h20M7 3v18"/><path d="M12 8l-2 5 2 5M14 8l2 5-2 5" strokeWidth="1.2"/></>} />,
  Upload:  (p) => <I {...p} d={<><path d="M12 16V4"/><path d="M6 10l6-6 6 6"/><path d="M4 20h16"/></>} />,
  Download:(p) => <I {...p} d={<><path d="M12 4v12"/><path d="M6 10l6 6 6-6"/><path d="M4 20h16"/></>} />,
  Print:   (p) => <I {...p} d={<><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="9" rx="2"/><path d="M6 14h12v7H6z"/></>} />,
  More:    (p) => <I {...p} d={<><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/></>} />,
  Link:    (p) => <I {...p} d={<><path d="M9 15l6-6"/><path d="M10 5l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M14 19l-1 1a4 4 0 0 1-6-6l1-1"/></>} />,
  Building:(p) => <I {...p} d={<><rect x="4" y="4" width="14" height="17" rx="1.5"/><path d="M8 8h2M8 12h2M8 16h2M14 8h-1M14 12h-1M14 16h-1"/><path d="M18 9h2v12h-2"/></>} />,
  Briefcase:(p) => <I {...p} d={<><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></>} />,
  Wallet:  (p) => <I {...p} d={<><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 13h3"/><path d="M3 10h18"/></>} />,
  Folder:  (p) => <I {...p} d={<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></>} />,
  Eye:     (p) => <I {...p} d={<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></>} />,
  EyeOff:  (p) => <I {...p} d={<><path d="M17.9 17.9A10 10 0 0 1 12 19c-6 0-10-7-10-7a18 18 0 0 1 5.1-5.9M9.9 4.2A10 10 0 0 1 12 4c6 0 10 8 10 8a18 18 0 0 1-2.1 3.1M3 3l18 18"/></>} />,
  File:    (p) => <I {...p} d={<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></>} />,
  Image:   (p) => <I {...p} d={<><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 17l-5-5-9 9"/></>} />,
  Clock:   (p) => <I {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>} />,
  Sparkle: (p) => <I {...p} d={<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3"/></>} />,
  Bank:    (p) => <I {...p} d={<><path d="M3 9l9-5 9 5"/><path d="M5 9v10M19 9v10M9 9v10M15 9v10M3 20h18"/></>} />,
  Card:    (p) => <I {...p} d={<><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></>} />,
  Pencil:  (p) => <I {...p} d={<><path d="M14.5 4.5l5 5L8 21H3v-5z"/><path d="M12.5 6.5l5 5"/></>} />,
  Trend:   (p) => <I {...p} d={<><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></>} />,
  TrendDn: (p) => <I {...p} d={<><path d="M3 7l6 6 4-4 8 8"/><path d="M14 17h7v-7"/></>} />,
  Menu:    (p) => <I {...p} d={<><path d="M3 6h18M3 12h18M3 18h18"/></>} />,
  Help:    (p) => <I {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/></>} />,
};

/* ── StatusBadge ── */
export const StatusBadge = ({ status }) => {
  const map = {
    "입금 완료": { tone: "pos" }, "입금 예정": { tone: "brand" }, "일부 입금": { tone: "warn" },
    "미수": { tone: "neg" }, "장기 미수": { tone: "neg" }, "취소": { tone: "outline" },
    "지급 완료": { tone: "pos" }, "지급 예정": { tone: "brand" }, "지급 대기": { tone: "warn" },
    "기한 지남": { tone: "neg" }, "지급 지연": { tone: "neg" }, "정산 완료": { tone: "pos" },
    "작성중": { tone: "outline" }, "승인 요청": { tone: "warn" }, "승인 대기": { tone: "warn" },
    "승인 완료": { tone: "pos" }, "반려": { tone: "neg" },
    "연결 완료": { tone: "pos" }, "연결 필요": { tone: "warn" }, "검토 필요": { tone: "warn" }, "누락": { tone: "neg" },
    "진행중": { tone: "brand" }, "완료": { tone: "pos" }, "보류": { tone: "warn" },
    "청구 예정": { tone: "outline" },
    "활성": { tone: "pos" }, "예정": { tone: "outline" }, "비활성": { tone: "outline" },
    "재직": { tone: "pos" }, "수습": { tone: "warn" }, "퇴사": { tone: "outline" }, "휴직": { tone: "warn" },
  };
  const tone = (map[status]?.tone) || "outline";
  return <span className={`badge ${tone}`}><span className="dot"/>{status}</span>;
};

/* ── Sparkline ── */
export const Sparkline = ({ data, w = 160, h = 40, color = "var(--brand)" }) => {
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${h - ((v - min) / span) * (h - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
};

/* ── Spacer ── */
export const Spacer = ({ h = 16 }) => <div style={{ height: h }} />;

/* ── Popover ── */
export const Popover = ({ trigger, children, align = "right", width = 240, direction = "down" }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "block" }}>
      {cloneElement(trigger, {
        onClick: (e) => { trigger.props.onClick?.(e); setOpen(o => !o); }
      })}
      {open && (
        <div
          style={{
            position: "absolute",
            ...(direction === "up" ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
            [align]: 0,
            width,
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: 12,
            boxShadow: "0 16px 40px -12px rgba(15,23,42,0.18), 0 1px 0 rgba(15,23,42,0.04)",
            zIndex: 40,
            overflow: "hidden",
            animation: "fadeUp .14s ease",
          }}
          onClick={(e) => { if (e.target.closest("[data-pop-item]")) setOpen(false); }}>
          {children}
        </div>
      )}
    </div>
  );
};

export const PopItem = ({ icon, label, sub, onClick, danger }) => (
  <button data-pop-item onClick={onClick}
    style={{
      width: "100%", display: "flex", alignItems: "center", gap: 10,
      padding: "10px 12px", border: 0, background: "transparent", textAlign: "left",
      fontFamily: "inherit", fontSize: 13, color: danger ? "var(--neg-ink)" : "var(--ink)",
      cursor: "pointer",
    }}
    onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
    {icon && <span style={{ color: danger ? "var(--neg-ink)" : "var(--muted)", display: "inline-flex" }}>{icon}</span>}
    <span style={{ fontWeight: 600 }}>{label}</span>
    {sub && <span style={{ marginLeft: "auto", color: "var(--muted-2)", fontSize: 11.5 }}>{sub}</span>}
  </button>
);

/* ── ConfirmDialog ── */
const CONFIRM_TONES = {
  info: { bg: "var(--brand-soft)", color: "var(--brand-ink)", btnBg: "var(--brand)",    btnColor: "#fff" },
  warn: { bg: "var(--warn-soft)",  color: "var(--warn-ink)",  btnBg: "var(--warn-ink)", btnColor: "#fff" },
  neg:  { bg: "var(--neg-soft)",   color: "var(--neg-ink)",   btnBg: "var(--neg)",      btnColor: "#fff" },
  pos:  { bg: "var(--pos-soft)",   color: "var(--pos)",       btnBg: "var(--pos)",      btnColor: "#fff" },
};

const ConfirmCtx = createContext({ confirm: () => {} });
export const useConfirm = () => useContext(ConfirmCtx);

export const ConfirmProvider = ({ children }) => {
  const [dlg, setDlg] = useState(null);
  const confirm = (opts) => new Promise(resolve => { setDlg({ ...opts, resolve }); });
  const close = (val) => { if (dlg?.resolve) dlg.resolve(val); setDlg(null); };

  const tone = dlg ? (CONFIRM_TONES[dlg.tone] ?? CONFIRM_TONES.info) : null;

  return (
    <ConfirmCtx.Provider value={{ confirm }}>
      {children}
      {dlg && (
        <div data-modal-open onClick={() => close(false)}
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(11,18,32,0.35)", display: "grid", placeItems: "center", backdropFilter: "blur(2px)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 16, width: "min(440px, calc(100vw - 32px))", padding: 28, boxShadow: "0 30px 60px -20px rgba(15,23,42,0.3)", animation: "fadeUp .18s ease" }}>

            {/* 아이콘 + 제목 */}
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14 }}>
              {dlg.icon && (
                <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: tone.bg, color: tone.color, display: "grid", placeItems: "center" }}>
                  {dlg.icon}
                </div>
              )}
              <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.35 }}>{dlg.title}</div>
            </div>

            {/* 본문 */}
            <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.65, paddingLeft: 2 }}>{dlg.body}</div>

            {/* 추가 정보 박스 */}
            {dlg.detail && (
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 10, padding: "11px 14px", fontSize: 12.5, color: "var(--muted)", marginBottom: 20 }}>
                {dlg.detail}
              </div>
            )}

            {/* 버튼 */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 24 }}>
              <button className="btn" onClick={() => close(false)}>{dlg.cancelLabel || "취소"}</button>
              <button className="btn"
                style={{ background: tone.btnBg, color: tone.btnColor, borderColor: tone.btnBg }}
                onClick={() => close(true)}>
                {dlg.confirmLabel || "확인"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
};

/* ── Toast ── */
const ToastCtx = createContext({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export const ToastProvider = ({ children }) => {
  const [items, setItems] = useState([]);
  const push = (msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    setItems(cur => [...cur, { id, msg, icon: opts.icon }]);
    setTimeout(() => setItems(cur => cur.filter(t => t.id !== id)), opts.duration || 2400);
  };
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-stack">
        {items.map(t => (
          <div key={t.id} className="toast">
            <Icon.Check size={16}/>
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
};

/* ── Combobox ── */
export const Combobox = ({ value, onChange, options, frequent = [], placeholder, onAddNew, allowAdd = true, addNewLabel = "새 항목 등록" }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);
  const popRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) { setOpen(false); setQ(""); }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    if (!q) return options;
    const lc = q.toLowerCase();
    return options.filter(o => o.label.toLowerCase().includes(lc) || (o.sub || "").toLowerCase().includes(lc));
  }, [q, options]);

  const selected = options.find(o => o.value === value);
  const display = selected?.label || "";

  const pick = (opt) => { onChange(opt.value); setOpen(false); setQ(""); };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[hi]) pick(filtered[hi]);
      else if (q && allowAdd) { onAddNew?.(q); setOpen(false); setQ(""); }
    } else if (e.key === "Escape") { setOpen(false); setQ(""); }
  };

  const freqOptions = frequent.map(v => options.find(o => o.value === v)).filter(Boolean);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 10); }}
        className="input"
        style={{ cursor: "text", display: "flex", alignItems: "center", gap: 8, paddingRight: 36,
          borderColor: open ? "var(--brand)" : undefined,
          boxShadow: open ? "0 0 0 3px var(--brand-soft)" : undefined }}>
        {open ? (
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setHi(0); }}
            onKeyDown={onKeyDown} placeholder={display || placeholder || "검색"}
            style={{ flex: 1, border: 0, outline: 0, background: "transparent", fontFamily: "inherit", fontSize: 13.5, color: "var(--ink)", padding: 0 }}/>
        ) : (
          <span style={{ flex: 1, color: display ? "var(--ink)" : "var(--muted-2)" }}>
            {display || placeholder || "선택하세요"}
          </span>
        )}
        <Icon.Down size={14} className="text-muted2" style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}/>
      </div>

      {open && (
        <div ref={popRef}
          style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
            background: "#fff", border: "1px solid var(--line)", borderRadius: 12,
            boxShadow: "0 16px 40px -12px rgba(15,23,42,0.18), 0 1px 0 rgba(15,23,42,0.04)",
            zIndex: 50, maxHeight: 320, overflow: "hidden",
            display: "flex", flexDirection: "column", animation: "fadeUp .14s ease" }}>
          {!q && freqOptions.length > 0 && (
            <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid var(--line)" }}>
              <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 6 }}>자주 쓰는 항목</div>
              <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                {freqOptions.map(o => (
                  <button key={o.value} type="button" className={`chip ${value === o.value ? "active" : ""}`}
                    onClick={() => pick(o)} style={{ fontSize: 12, padding: "4px 10px" }}>{o.label}</button>
                ))}
              </div>
            </div>
          )}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 && (
              <div style={{ padding: "16px 14px", color: "var(--muted-2)", fontSize: 13, textAlign: "center" }}>
                검색 결과가 없어요{allowAdd && q ? ". Enter로 새로 등록할 수 있어요." : "."}
              </div>
            )}
            {filtered.map((o, i) => (
              <button key={o.value} type="button" onClick={() => pick(o)} onMouseEnter={() => setHi(i)}
                style={{ width: "100%", textAlign: "left", padding: "9px 14px", border: 0,
                  background: hi === i ? "var(--surface-2)" : "transparent",
                  cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 10 }}>
                {value === o.value && <Icon.Check size={14} style={{ color: "var(--brand)" }}/>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fw-600 text-sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</div>
                  {o.sub && <div className="text-xs text-muted2" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.sub}</div>}
                </div>
              </button>
            ))}
          </div>
          {allowAdd && onAddNew && (
            <div style={{ borderTop: "1px solid var(--line)" }}>
              <button type="button"
                onClick={() => { onAddNew(q); setOpen(false); setQ(""); }}
                style={{ width: "100%", textAlign: "left", padding: "10px 14px", border: 0,
                  background: "transparent", cursor: "pointer", fontFamily: "inherit",
                  display: "flex", alignItems: "center", gap: 8, color: "var(--brand-ink)", fontWeight: 600, fontSize: 13 }}>
                <Icon.Plus size={14}/>
                {q ? `"${q}" ${addNewLabel}` : addNewLabel}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
