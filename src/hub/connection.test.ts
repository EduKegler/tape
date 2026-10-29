import { describe, expect, it } from 'vitest'
import type { StreamKey } from '@tape/core/ids'
import { stepConnection } from './connection'
import type { ConnEffect, ConnState } from './connection'

const policy = { silenceMs: 30_000, keepaliveMs: null }
const keys = (...k: string[]) => new Set(k as StreamKey[])
const input = (desired: Set<StreamKey>, now = 0, lastMessageAt = now) => ({ desired, now, lastMessageAt, rand: 0.5 })
const fx = (effects: readonly ConnEffect[]) =>
  effects.map((e) => ('streams' in e ? `${e.fx}:${e.streams.join(',')}` : e.fx))

describe('stepConnection', () => {
  it('opens, then subscribes and resets everything desired', () => {
    const a = stepConnection({ s: 'idle' }, { e: 'tick' }, input(keys('a', 'b')), policy)
    expect(fx(a.effects)).toEqual(['open'])
    const b = stepConnection(a.state, { e: 'opened' }, input(keys('a', 'b')), policy)
    expect(fx(b.effects)).toEqual(['subscribe:a,b', 'streams-reset:a,b'])
  })

  it('moves subscriptions toward the desired set and does nothing when they match', () => {
    const open: ConnState = {
      s: 'open',
      subscribed: keys('a', 'b'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 0,
      openedAt: 0,
      holds: new Map(),
    }
    const step = stepConnection(open, { e: 'tick' }, input(keys('b', 'c')), policy)
    expect(fx(step.effects)).toEqual(['unsubscribe:a', 'subscribe:c', 'streams-reset:c'])
    expect(fx(stepConnection(step.state, { e: 'tick' }, input(keys('b', 'c')), policy).effects)).toEqual([])
  })

  it('treats a silent socket as dead', () => {
    const open: ConnState = {
      s: 'open',
      subscribed: keys('a'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 0,
      openedAt: 0,
      holds: new Map(),
    }
    const step = stepConnection(open, { e: 'tick' }, input(keys('a'), 31_000, 0), policy)
    expect(fx(step.effects)).toEqual(['close', 'streams-stale:a'])
    expect(step.state.s).toBe('backoff')
  })

  it('reconnects after backoff and resubscribes from the desired set', () => {
    const open: ConnState = {
      s: 'open',
      subscribed: keys('a'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 0,
      openedAt: 0,
      holds: new Map(),
    }
    const closed = stepConnection(open, { e: 'closed' }, input(keys('a')), policy)
    expect(fx(closed.effects)).toEqual(['streams-stale:a'])
    const later = stepConnection(closed.state, { e: 'tick' }, input(keys('a'), 60_000), policy)
    expect(fx(later.effects)).toEqual(['open'])
    const opened = stepConnection(later.state, { e: 'opened' }, input(keys('a'), 60_000), policy)
    expect(fx(opened.effects)).toEqual(['subscribe:a', 'streams-reset:a'])
  })

  it('resubscribes a corrupt stream in place', () => {
    const open: ConnState = {
      s: 'open',
      subscribed: keys('a'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 0,
      openedAt: 0,
      holds: new Map(),
    }
    expect(
      fx(stepConnection(open, { e: 'resubscribe', streams: ['a' as StreamKey] }, input(keys('a')), policy).effects),
    ).toEqual(['unsubscribe:a', 'subscribe:a', 'streams-reset:a'])
  })

  it('closes when nothing is wanted', () => {
    const open: ConnState = {
      s: 'open',
      subscribed: keys('a'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 0,
      openedAt: 0,
      holds: new Map(),
    }
    expect(fx(stepConnection(open, { e: 'tick' }, input(keys()), policy).effects)).toEqual(['close'])
  })

  it('keeps backing off when the venue accepts and drops at once', () => {
    let state: ConnState = { s: 'idle' }
    const delays: number[] = []
    let now = 0
    for (let i = 0; i < 4; i++) {
      state = stepConnection(state, { e: 'tick' }, input(keys('a'), now), policy).state
      state = stepConnection(state, { e: 'opened' }, input(keys('a'), now), policy).state
      state = stepConnection(state, { e: 'closed' }, input(keys('a'), now + 100), policy).state
      if (state.s !== 'backoff') throw new Error('expected backoff')
      delays.push(state.retryAt - (now + 100))
      now = state.retryAt
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000].map((d) => d * 0.75))
  })

  it('starts the backoff over after a connection that stayed up', () => {
    const open: ConnState = {
      s: 'open',
      subscribed: keys('a'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 5,
      openedAt: 0,
      holds: new Map(),
    }
    const closed = stepConnection(open, { e: 'closed' }, input(keys('a'), 60_000), policy)
    expect(closed.state).toMatchObject({ s: 'backoff', attempt: 0 })
  })

  it('holds a stream that keeps going corrupt instead of resubscribing in a loop', () => {
    let state: ConnState = {
      s: 'open',
      subscribed: keys('a'),
      lastMessageAt: 0,
      lastKeepaliveAt: 0,
      attempt: 0,
      openedAt: 0,
      holds: new Map(),
    }
    const bad = { e: 'resubscribe', streams: ['a' as StreamKey] } as const
    const first = stepConnection(state, bad, input(keys('a'), 0), policy)
    expect(fx(first.effects)).toEqual(['unsubscribe:a', 'subscribe:a', 'streams-reset:a'])
    expect(fx(stepConnection(first.state, { e: 'tick' }, input(keys('a'), 500), policy).effects)).toEqual([])
    const second = stepConnection(first.state, bad, input(keys('a'), 600), policy)
    expect(fx(second.effects)).toEqual(['unsubscribe:a'])
    state = second.state
    expect(fx(stepConnection(state, { e: 'tick' }, input(keys('a'), 4_000), policy).effects)).toEqual([])
    expect(fx(stepConnection(state, { e: 'tick' }, input(keys('a'), 4_700), policy).effects)).toEqual([
      'subscribe:a',
      'streams-reset:a',
    ])
  })
})
