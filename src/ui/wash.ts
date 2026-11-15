import { useEffect, useRef, useState } from 'react'
import type { VenueId } from '@tape/core/ids'
import type { CompareRow } from '#/core/topics'
import { NO_LIFTS, takeLifts } from './lead'

const WASH_MS = 900
const NONE: ReadonlySet<string> = new Set()

export function useWashCount(cause: unknown, active: boolean): number {
  const [washed, setWashed] = useState<{ cause: unknown; count: number }>({ cause: null, count: 0 })
  if (active && cause !== washed.cause) {
    const next = { cause, count: washed.count + 1 }
    setWashed(next)
    return next.count
  }
  return washed.count
}

export function useWashing(count: number): boolean {
  const [settled, setSettled] = useState(0)
  useEffect(() => {
    if (count === 0) return
    const timer = setTimeout(() => setSettled(count), WASH_MS)
    return () => clearTimeout(timer)
  }, [count])
  return count !== settled
}

export function useLifts(rows: readonly CompareRow[]): Partial<Record<VenueId, number>> {
  const [counts, setCounts] = useState<Partial<Record<VenueId, number>>>({})
  const state = useRef(NO_LIFTS)
  useEffect(() => {
    const next = takeLifts(state.current, rows, Date.now())
    state.current = next.state
    if (next.lifted.length === 0) return
    setCounts((current) => {
      const updated = { ...current }
      for (const venue of next.lifted) updated[venue] = (current[venue] ?? 0) + 1
      return updated
    })
  }, [rows])
  return counts
}

export function useChangedKeys<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  signatureOf: (item: T) => string,
): ReadonlySet<string> {
  const signatures = new Map(items.map((item) => [keyOf(item), signatureOf(item)]))
  const [seen, setSeen] = useState(signatures)
  const [washing, setWashing] = useState<ReadonlySet<string>>(NONE)
  const changed = [...signatures].filter(([key, signature]) => seen.get(key) !== signature).map(([key]) => key)
  if (signatures.size !== seen.size || changed.length > 0) {
    setSeen(signatures)
    if (changed.length > 0) setWashing(new Set([...washing, ...changed]))
  }
  useEffect(() => {
    if (washing.size === 0) return
    const timer = setTimeout(() => setWashing(NONE), WASH_MS)
    return () => clearTimeout(timer)
  }, [washing])
  return washing
}
