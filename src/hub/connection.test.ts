import { describe, expect, it } from 'vitest'
import type { StreamKey } from '#/core/ids'
import { stepConnection } from './connection'
import type { ConnEffect, ConnState } from './connection'

const policy = { silenceMs: 30_000, keepaliveMs: null }
const keys = (...k: string[]) => new Set(k as StreamKey[])
const input = (desired: Set<StreamKey>, now = 0, lastMessageAt = now) => ({ desired, now, lastMessageAt, rand: 0.5 })
const fx = (effects: readonly ConnEffect[]) => effects.map((e) => ('streams' in e ? `${e.fx}:${e.streams.join(',')}` : e.fx))

describe('stepConnection', () => {
  it('opens, then subscribes and resets everything desired', () => {
    const a = stepConnection({ s: 'idle' }, { e: 'tick' }, input(keys('a', 'b')), policy)
    expect(fx(a.effects)).toEqual(['open'])
    const b = stepConnection(a.state, { e: 'opened' }, input(keys('a', 'b')), policy)
    expect(fx(b.effects)).toEqual(['subscribe:a,b', 'streams-reset:a,b'])
  })

  it('moves subscriptions toward the desired set and does nothing when they match', () => {
    const open: ConnState = { s: 'open', subscribed: keys('a', 'b'), lastMessageAt: 0, lastKeepaliveAt: 0 }
    const step = stepConnection(open, { e: 'tick' }, input(keys('b', 'c')), policy)
    expect(fx(step.effects)).toEqual(['unsubscribe:a', 'subscribe:c', 'streams-reset:c'])
    expect(fx(stepConnection(step.state, { e: 'tick' }, input(keys('b', 'c')), policy).effects)).toEqual([])
  })

  it('treats a silent socket as dead', () => {
    const open: ConnState = { s: 'open', subscribed: keys('a'), lastMessageAt: 0, lastKeepaliveAt: 0 }
    const step = stepConnection(open, { e: 'tick' }, input(keys('a'), 31_000, 0), policy)
    expect(fx(step.effects)).toEqual(['close', 'streams-stale:a'])
    expect(step.state.s).toBe('backoff')
  })

  it('reconnects after backoff and resubscribes from the desired set', () => {
    const open: ConnState = { s: 'open', subscribed: keys('a'), lastMessageAt: 0, lastKeepaliveAt: 0 }
    const closed = stepConnection(open, { e: 'closed' }, input(keys('a')), policy)
    expect(fx(closed.effects)).toEqual(['streams-stale:a'])
    const later = stepConnection(closed.state, { e: 'tick' }, input(keys('a'), 60_000), policy)
    expect(fx(later.effects)).toEqual(['open'])
    const opened = stepConnection(later.state, { e: 'opened' }, input(keys('a'), 60_000), policy)
    expect(fx(opened.effects)).toEqual(['subscribe:a', 'streams-reset:a'])
  })

  it('resubscribes a corrupt stream in place', () => {
    const open: ConnState = { s: 'open', subscribed: keys('a'), lastMessageAt: 0, lastKeepaliveAt: 0 }
    expect(fx(stepConnection(open, { e: 'resubscribe', streams: ['a' as StreamKey] }, input(keys('a')), policy).effects)).toEqual([
      'unsubscribe:a', 'subscribe:a', 'streams-reset:a',
    ])
  })

  it('closes when nothing is wanted', () => {
    const open: ConnState = { s: 'open', subscribed: keys('a'), lastMessageAt: 0, lastKeepaliveAt: 0 }
    expect(fx(stepConnection(open, { e: 'tick' }, input(keys()), policy).effects)).toEqual(['close'])
  })
})
