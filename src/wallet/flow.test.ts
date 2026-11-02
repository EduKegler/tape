import { describe, expect, it } from 'vitest'
import { ProviderNotFoundError } from 'wagmi'
import { browserWallets, connectFailure, settleFrame, settleMs, waitClock } from './flow'

describe('connect failure', () => {
  it('reads a missing provider as no wallet', () => {
    expect(connectFailure(new ProviderNotFoundError())).toEqual({ kind: 'no-wallet' })
  })

  it('reads EIP-1193 code 4001 as the trader saying no, also from a plain object', () => {
    expect(connectFailure({ code: 4001, message: 'User rejected the request.' })).toEqual({ kind: 'rejected' })
  })

  it('keeps the first line of anything else', () => {
    expect(connectFailure(new Error('Request already pending.\n\nDetails: -32002'))).toEqual({
      kind: 'other',
      message: 'Request already pending.',
    })
  })
})

describe('browser wallets', () => {
  const injected = { id: 'injected', type: 'injected' }
  const rabby = { id: 'io.rabby', type: 'injected' }
  const metamask = { id: 'io.metamask', type: 'injected' }
  const phone = { id: 'walletConnect', type: 'walletConnect' }

  it('lists the announced wallets and drops the window.ethereum one they already cover', () => {
    expect(browserWallets([injected, phone, rabby, metamask], true)).toEqual([rabby, metamask])
  })

  it('falls back to window.ethereum when nothing announces itself', () => {
    expect(browserWallets([injected, phone], true)).toEqual([injected])
  })

  it('lists nothing when the browser has no wallet', () => {
    expect(browserWallets([injected, phone], false)).toEqual([])
  })
})

describe('wait clock', () => {
  it.each([
    [0, '0:00.0'],
    [3_456, '0:03.4'],
    [59_999, '0:59.9'],
    [61_200, '1:01.2'],
  ])('reads %i ms as %s', (elapsed, shown) => {
    expect(waitClock(elapsed)).toBe(shown)
  })
})

describe('address settle', () => {
  const address = '0x7a3F…c91E'

  it('starts with every hex digit after 0x stood in for', () => {
    expect(settleFrame(address, 0)).toBe('0xe5c3…18f6')
  })

  it('ends on the address', () => {
    expect(settleMs(address)).toBe(346)
    expect(settleFrame(address, settleMs(address))).toBe(address)
  })

  it('settles left to right, keeping the length and the ellipsis', () => {
    for (let elapsed = 0; elapsed <= settleMs(address); elapsed++) {
      const frame = settleFrame(address, elapsed)
      expect(frame).toHaveLength(address.length)
      expect(frame[6]).toBe('…')
      const settled = Math.max(2, Math.min(Math.floor((elapsed - 60) / 26) + 1, address.length))
      expect(frame.slice(0, settled)).toBe(address.slice(0, settled))
    }
  })
})
