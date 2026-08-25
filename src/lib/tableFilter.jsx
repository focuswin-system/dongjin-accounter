import { useState, useMemo, useRef, useCallback } from 'react'
import { FilterSelect } from './ui'

/* 표 필터 한 벌 — 상태 + 거르는 규칙 + 툴바 props 를 한 곳에서 만든다.
 *
 * TableToolbar 는 **생김새**만 공용이었다. 정작 매번 다시 쓰던 것은 그 뒤였다:
 *   const [range, setRange] = useState(...)      // 화면마다 3~5줄
 *   const [q, setQ] = useState('')
 *   const [filterCat, setFilterCat] = useState(null)
 *   rows.filter(t => t.date >= range.from) ...   // 같은 술어를 또 손으로
 *
 * 손으로 다시 쓰니 조용히 갈라졌다. 실제로 거래내역에서
 *   · scoped       기간·비목·**주문**·검색
 *   · plannedRows  기간·비목·검색        ← 주문 필터가 빠져 있었다
 * 그래서 주문으로 좁혀도 예정분(미수금·미지급금)은 전 주문이 그대로 떠 있었다.
 * 한 화면이 두 가지 기준을 동시에 말한 셈이다. 규칙을 여기 하나만 둔다.
 *
 * ── 쓰는 법 ──
 *   1. 훅을 부른다 — date 에 기준 날짜 칸, search 에 훑을 칸들, filters 에 고르는 축.
 *      기본 기간이 필요하면 date.initial 에 periodToRange 의 결과를 넣는다.
 *   2. 툴바에 toolbarProps 를 그대로 펼쳐 넣는다. right 같은 화면 고유 노드만 덧붙인다.
 *   3. 행을 거를 때 apply 를 쓴다 — const rows = useMemo 로 감싸 apply 를 deps 에 둔다.
 *
 * apply 는 **여러 행 묶음에 같이 쓰라고** 함수로 돌려준다(실거래 + 예정분처럼).
 * 그게 위의 어긋남을 애초에 못 만들게 하는 지점이다.
 *
 * ⚠ 예시를 코드 모양으로 적지 않는 이유: check:isolation [7] 이 주석을 걷어내지 않고
 *   심볼 사용을 찾아서, 주석 속 예시가 'import 없이 쓴 공용 부품'으로 잡힌다.
 */

// 필드는 이름('date') 또는 뽑는 함수(row => …). 화면마다 날짜 칸 이름이 다르다
// (거래=date, 청구서=issuedAt, 예정 회차=due_date).
const get = (row, f) => (typeof f === 'function' ? f(row) : row?.[f])

export const useTableFilter = ({ date, search, filters = [] } = {}) => {
  const [range, setRange] = useState(() => date?.initial || { from: '', to: '' })
  const [q, setQ] = useState('')
  const [values, setValues] = useState({})   // { [filter.key]: 고른 값 | null }

  /* 설정(날짜 칸·검색 대상·필터 정의)은 ref 로 들고 있는다.
     그냥 두면 부모가 매 렌더 새 배열을 만들어 apply 의 정체성이 계속 바뀌고,
     apply 를 deps 에 넣은 useMemo 가 전부 매 렌더 다시 도는 표가 된다. */
  const cfg = useRef(null)
  cfg.current = { date, search, filters }

  const setValue = useCallback((key, v) => {
    setValues(prev => ({ ...prev, [key]: (v === '' || v === undefined) ? null : v }))
  }, [])

  const active = filters.filter(f => values[f.key] != null)
  const hasActiveFilter = active.length > 0
  /* ⚙ 버튼의 활성 점은 **패널 안의** 필터만 센다. 인라인 필터는 바에 값이 그대로 보이므로,
     그것 때문에 점이 켜지면 "뭐가 더 걸려 있나" 하고 패널을 열게 된다(열면 비어 있다). */
  const hasActivePanelFilter = active.some(f => !f.inline)

  const reset = useCallback(() => {
    setValues({})
    setQ('')
    setRange(cfg.current.date?.initial || { from: '', to: '' })
  }, [])

  /* 거르는 규칙 — 값이 바뀔 때만 새로 만든다.
     값이 비면(null·'') 그 축은 아예 안 본다. "전체"가 곧 무필터다. */
  const apply = useCallback((rows) => {
    const { date, search, filters } = cfg.current
    if (!Array.isArray(rows)) return []
    return rows.filter(row => {
      if (date) {
        const d = get(row, date.field || 'date')
        /* 값이 **범위**인 행도 있다 — 청구서의 납품일이 그렇다.
           품목 줄마다 날짜가 달라(8/5·8/12·8/27 을 8월분 한 장으로 묶는다) 하나로 정해지지
           않는다. 그래서 [시작, 끝] 배열이면 **겹치는지**로 본다. 시작일만 보면
           8/20~8/31 로 좁혔을 때 8/27 납품분이 든 청구서가 통째로 빠진다. */
        if (Array.isArray(d)) {
          const [ds, de] = [d[0] || '', d[1] || d[0] || '']
          if (!ds) return false                                   // 날짜를 안 적은 행
          if (range.from && de < range.from) return false
          if (range.to && ds > range.to) return false
        } else {
          const v = d || ''
          /* 날짜가 **없는** 행은 기간을 걸었을 때 뺀다. 남겨두면 "8월"로 좁혀놨는데
             날짜 미상 행이 계속 따라와, 그 표의 합계를 8월 숫자로 믿을 수 없게 된다. */
          if (range.from && (!v || v < range.from)) return false
          if (range.to && (!v || v > range.to)) return false
        }
      }
      for (const f of filters) {
        const v = values[f.key]
        if (v == null) continue
        // match 를 주면 그걸 쓴다 — 한 값이 여러 칸에 걸리는 축이 있다
        // (주문: 근거 주문과 원가 귀속 주문 둘 다 봐야 "이 주문에 붙은 것 전부"가 된다).
        if (f.match ? !f.match(row, v) : get(row, f.field || f.key) !== v) return false
      }
      if (q && search?.fields?.length) {
        const lc = q.toLowerCase()
        const hay = search.fields.map(fd => get(row, fd) ?? '').join(' ').toLowerCase()
        if (!hay.includes(lc)) return false
      }
      return true
    })
  }, [range.from, range.to, q, values])

  /* TableToolbar 에 그대로 펼쳐 넣는다. right 같은 화면 고유 노드는 호출부에서 덧붙인다.
     options 는 보통 행에서 뽑은 목록이라 렌더마다 새로 오지만, 여기는 렌더 시점에
     읽으므로 최신 값이 그대로 쓰인다. */
  const toolbarProps = {
    date: date ? { from: range.from || '', to: range.to || '', onChange: setRange } : undefined,
    search: search ? { value: q, onChange: setQ, placeholder: search.placeholder || '검색' } : undefined,
    /* inline: true 인 필터는 **패널이 아니라 툴바 바에** 선다.
       자주 쓰는 축(거래처처럼)이 ⚙ 뒤에 숨어 있으면 매번 두 번을 눌러야 하고,
       무엇으로 걸러져 있는지도 패널을 열기 전엔 안 보인다. */
    filters: filters.map(f => ({
      label: f.label,
      inline: !!f.inline,
      node: f.node
        ? f.node(values[f.key] ?? null, (v) => setValue(f.key, v))
        : <FilterSelect value={values[f.key] ?? null} onChange={(v) => setValue(f.key, v)}
            options={f.options || []} placeholder={f.placeholder || '전체'}/>,
    })),
    hasActiveFilter: hasActivePanelFilter,
    onReset: reset,
  }

  return {
    apply, toolbarProps, reset, hasActiveFilter,
    range, setRange, q, setQ,
    values, setValue,
    // 지금 걸린 게 하나라도 있는지 — "필터를 걸어서 비어 보이는 것"과 "원래 없는 것"을
    // 빈 화면 문구에서 갈라 말할 때 쓴다.
    isFiltered: hasActiveFilter || !!q || !!range.from || !!range.to,
  }
}

/** 달 문자열('2026-09') → 그 달 1일~말일. 말일은 다음 달 0일로 구한다(28/30/31을 손으로 세지 않는다). */
export const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number)
  return { from: `${month}-01`, to: `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` }
}

/** 기간이 정확히 어느 한 달인지 — 소계 칩의 '눌린 상태'를 되짚을 때 쓴다. 아니면 null. */
export const activeMonthOf = (range) => (
  range?.from && range?.to && range.from.endsWith('-01')
  && range.from.slice(0, 7) === range.to.slice(0, 7)
    ? range.from.slice(0, 7) : null
)
