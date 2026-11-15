import { createContext, useContext, useEffect, useEffectEvent, useState } from 'react'
import type { ReactNode } from 'react'
import { createStore } from '@tanstack/store'
import { useSelector } from '@tanstack/react-store'
import type { HubStats } from '#/core/protocol'
import { topicKey } from '#/core/topics'
import type { FrameOf, Topic } from '#/core/topics'
import type { HubClient } from './registry'

const HubContext = createContext<HubClient | null>(null)
const NOTHING = createStore<null>(null)

let connection: Promise<HubClient> | undefined
const connectOnce = () => (connection ??= import('./connect').then(({ connectHub }) => connectHub()))

export function HubProvider({ children }: { readonly children: ReactNode }) {
  const [client, setClient] = useState<HubClient | null>(null)
  useEffect(() => {
    void connectOnce().then(setClient)
  }, [])
  return <HubContext value={client}>{children}</HubContext>
}

const identity = <T,>(value: T) => value

export function useFrame<T extends Topic>(topic: T): FrameOf<T> | null
export function useFrame<T extends Topic, TSelected>(
  topic: T,
  select: (frame: FrameOf<T> | null) => TSelected,
  compare?: (a: TSelected, b: TSelected) => boolean,
): TSelected
export function useFrame<T extends Topic>(
  topic: T,
  select: (frame: FrameOf<T> | null) => unknown = identity,
  compare?: (a: unknown, b: unknown) => boolean,
): unknown {
  const client = useContext(HubContext)
  const key = topicKey(topic)
  const store = client ? client.store(topic) : NOTHING
  const retain = useEffectEvent(() => client?.retain(topic))
  useEffect(() => retain(), [client, key])
  return useSelector(store, select, compare ? { compare } : undefined)
}

export function useFrameEffect<T extends Topic>(topic: T, onFrame: (frame: FrameOf<T>) => void): void {
  const client = useContext(HubContext)
  const key = topicKey(topic)
  const emit = useEffectEvent(onFrame)
  const start = useEffectEvent(() => {
    if (!client) return
    const release = client.retain(topic)
    const store = client.store(topic)
    const current = store.get()
    if (current) emit(current)
    const sub = store.subscribe((frame) => frame && emit(frame))
    return () => {
      sub.unsubscribe()
      release()
    }
  })
  useEffect(() => start(), [client, key])
}

export function useHubStats(): HubStats | null {
  const client = useContext(HubContext)
  return useSelector(client?.stats ?? NOTHING)
}
