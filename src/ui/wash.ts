import { useEffect, useRef, useState } from 'react'
import type { VenueId } from '@tape/core/ids'
import type { CompareRow } from '#/core/topics'
import { NO_LIFTS, takeLifts } from './lead'

const WASH_MS = 900

export function useWashCount(cause: unknown, active: boolean): number {
  const [count, setCount] = useState(0)
  const seen = useRef<unknown>(null)
  useEffect(() => {
    if (!active || cause === seen.current) return
    seen.current = cause
    setCount((value) => value + 1)
  }, [cause, active])
  return count
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
  const [washing, setWashing] = useState<ReadonlySet<string>>(() => new Set())
  const before = useRef<ReadonlyMap<string, string> | null>(null)
  useEffect(() => {
    const now = new Map(items.map((item) => [keyOf(item), signatureOf(item)]))
    const previous = before.current
    before.current = now
    if (!previous) return
    const changed = [...now].filter(([key, signature]) => previous.get(key) !== signature).map(([key]) => key)
    if (changed.length > 0) setWashing((current) => new Set([...current, ...changed]))
  }, [items, keyOf, signatureOf])
  useEffect(() => {
    if (washing.size === 0) return
    const timer = setTimeout(() => setWashing(new Set()), WASH_MS)
    return () => clearTimeout(timer)
  }, [washing])
  return washing
}
