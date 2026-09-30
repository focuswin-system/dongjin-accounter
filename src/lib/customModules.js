/**
 * 이 회사에 켜진 고객사 전용 모듈 — 화면 어디서든 묻는다.
 *
 * App.jsx 가 로그인 때 한 번 받아(api.mesStatus) 여기에 넣는다. 화면은 훅으로 읽는다.
 * null = 아직 모름. 모르는 동안은 '안 켜짐'으로 본다(칸을 감추는 쪽이 아니라 보이는 쪽이 기본 —
 * 켜진 회사에서 잠깐 보였다 사라지는 것이, 안 켜진 회사에서 칸이 사라지는 것보다 덜 해롭다).
 */
import { useState, useEffect } from 'react'

let keys = null
const listeners = new Set()

export function setCustomKeys(k) {
  keys = k
  for (const f of listeners) f(k)
}

export function useCustomKeys() {
  const [k, setK] = useState(keys)
  useEffect(() => {
    listeners.add(setK)
    setK(keys)
    return () => { listeners.delete(setK) }
  }, [])
  return k
}

/* 수주·발주의 원본이 MES 인가(동진). 그러면 회계 쪽 수주·발주(contracts)를 입력 폼에서 고르게 두지 않는다 —
   계약관리 메뉴는 MES 화면인데 폼에서만 회계 주문이 보여 "이건 무슨 수주냐"가 됐다(2026-09-29 사용자 A안).
   이미 연결된 값은 데이터에 그대로 남는다(칸만 감춘다). MES PO 로 잇는 것은 지출결의서 연결 때 함께. */
export const useOrdersFromMes = () => (useCustomKeys() || []).includes('dongjin_mes')
