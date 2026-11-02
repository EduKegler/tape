import { describe, expect, it } from 'vitest'
import { panelState, readState } from './panel-state'

const NOW = 1_000_000
const base = {
  status: 'live',
  liveAt: NOW,
  now: NOW,
  sockets: 4,
  error: null,
  source: 'Hyperliquid',
  staleAfterMs: 15_000,
} as const

describe('panel state', () => {
  it('shows nothing beside live data on an open socket', () => {
    expect(panelState(base)).toEqual({ data: 'live', connection: 'connected', text: null })
  })

  it('says it is loading before the first frame on an open socket', () => {
    expect(panelState({ ...base, status: null, liveAt: null })).toEqual({
      data: 'empty',
      connection: 'connected',
      text: 'Loading…',
    })
  })

  it('keeps old data readable with its age while the socket reconnects', () => {
    expect(panelState({ ...base, status: 'stale', liveAt: NOW - 12_000 })).toEqual({
      data: 'stale',
      connection: 'reconnecting',
      text: 'Reconnecting · 12 s old',
    })
  })

  it('names the venue it waits for when nothing arrived and the socket reconnects', () => {
    expect(panelState({ ...base, status: 'stale', liveAt: null })).toEqual({
      data: 'empty',
      connection: 'reconnecting',
      text: 'Waiting for Hyperliquid',
    })
  })

  it('says offline with the age when the hub has no socket open', () => {
    expect(panelState({ ...base, status: 'stale', liveAt: NOW - 40_000, sockets: 0 })).toEqual({
      data: 'stale',
      connection: 'down',
      text: 'Offline · 40 s old',
    })
  })

  it('reads a resync after live data as reconnecting', () => {
    expect(panelState({ ...base, status: 'syncing', liveAt: NOW - 3_000 })).toMatchObject({
      data: 'stale',
      connection: 'reconnecting',
    })
  })

  it('turns stale on an open socket once the last frame is older than the limit', () => {
    expect(panelState({ ...base, liveAt: NOW - 15_001 })).toEqual({
      data: 'stale',
      connection: 'connected',
      text: 'No updates · 15 s old',
    })
    expect(panelState({ ...base, liveAt: NOW - 15_000 }).data).toBe('live')
  })

  it('never turns stale by age when the panel has no age limit', () => {
    expect(panelState({ ...base, liveAt: NOW - 600_000, staleAfterMs: null }).data).toBe('live')
  })

  it('counts minutes past two minutes', () => {
    expect(panelState({ ...base, status: 'stale', liveAt: NOW - 180_000 }).text).toBe('Reconnecting · 3 min old')
  })

  it('puts a read error ahead of every other state', () => {
    expect(panelState({ ...base, status: 'stale', liveAt: null, error: 'Could not load history.' })).toEqual({
      data: 'error',
      connection: 'reconnecting',
      text: 'Could not load history.',
    })
  })
})

describe('read state', () => {
  const READ_AT = Date.UTC(2026, 10, 2, 14, 3, 12)

  it('says it is loading before the first read', () => {
    expect(readState({ readAt: null, reading: true, now: READ_AT })).toEqual({
      data: 'empty',
      connection: 'connected',
      text: 'Loading…',
    })
  })

  it('says nothing when there is nothing to read', () => {
    expect(readState({ readAt: null, reading: false, now: READ_AT })).toMatchObject({ data: 'empty', text: null })
  })

  it('shows the UTC time of a settled read', () => {
    expect(readState({ readAt: READ_AT, reading: false, now: READ_AT + 70_000 })).toEqual({
      data: 'live',
      connection: 'connected',
      text: 'Read 14:03:12 UTC',
    })
  })

  it('keeps the old read readable as stale, with its age, while it reads again', () => {
    expect(readState({ readAt: READ_AT, reading: true, now: READ_AT + 70_000 })).toEqual({
      data: 'stale',
      connection: 'connected',
      text: 'Reading… · 70 s old',
    })
  })
})
