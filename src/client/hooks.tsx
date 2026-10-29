import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createStore } from '@tanstack/store'
import { useSelector } from '@tanstack/react-store'
import type { HubStats } from '#/core/protocol'
import { topicKey } from '#/core/topics'
import type { FrameOf, Topic } from '#/core/topics'
import type { HubClient } from './registry'

const HubContext = createContext<HubClient | null>(null)
const NOTHING = createStore<null>(null)

/** Starts the hub client after hydration. During SSR and the first paint every hook reads null. */
export function HubProvider({ children }: { readonly children: ReactNode }) {
  const [client, setClient] = useState<HubClient | null>(null)
  useEffect(() => {
    void import('./connect').then(({ connectHub }) => setClient(connectHub()))
  }, [])
  return <HubContext value={client}>{children}</HubContext>
}

const identity = <T,>(x: T) => x

/**
 * Reads a slice of a topic's latest frame and re-renders only when that slice changes under
 * `compare`. Passing an inline topic literal is fine: it is keyed by topicKey.
 */
export function useFrame<T extends Topic, S = FrameOf<T> | null>(
  topic: T,
  select: (frame: FrameOf<T> | null) => S = identity as never,
  compare?: (a: S, b: S) => boolean,
): S {
  const client = useContext(HubContext)
  const key = topicKey(topic)
  const latest = useRef(topic)
  latest.current = topic
  const store = client ? client.store(topic) : NOTHING
  useEffect(() => client?.retain(latest.current), [client, key])
  return useSelector(store, select as (f: FrameOf<T> | null) => S, compare ? { compare } : undefined)
}

/** Runs an imperative callback per frame without rendering, for canvas and chart series. */
export function useFrameEffect<T extends Topic>(topic: T, onFrame: (frame: FrameOf<T>) => void): void {
  const client = useContext(HubContext)
  const key = topicKey(topic)
  const latest = useRef({ topic, onFrame })
  latest.current = { topic, onFrame }
  useEffect(() => {
    if (!client) return
    const release = client.retain(latest.current.topic)
    const store = client.store(latest.current.topic)
    const current = store.get()
    if (current) latest.current.onFrame(current)
    const sub = store.subscribe((f) => f && latest.current.onFrame(f))
    return () => {
      sub.unsubscribe()
      release()
    }
  }, [client, key])
}

export function useHubStats(): HubStats | null {
  const client = useContext(HubContext)
  return useSelector(client?.stats ?? NOTHING)
}
