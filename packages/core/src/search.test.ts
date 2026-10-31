import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Base } from './ids'
import type { MarketGroup, MarketSpec } from './market'
import { searchMarkets } from './search'

const spec = (base: string) => ({ base: base as Base }) as MarketSpec
const group = (name: string | null, bases: string[]): MarketGroup => ({
  dex: name ?? '',
  name,
  markets: bases.map(spec),
})
const names = (groups: readonly MarketGroup[]) =>
  groups.map((marketGroup) => [marketGroup.name, marketGroup.markets.map((market) => market.base)])

describe('market search', () => {
  it('puts the exact name first, then names that start with the query, then names that hold it', () => {
    const venue = [group(null, ['BABYDOGE', 'SOL', 'DOGECOIN', 'DOGE', 'BTC'])]
    expect(names(searchMarkets(venue, 'doge'))).toEqual([[null, ['DOGE', 'DOGECOIN', 'BABYDOGE']]])
    expect(names(searchMarkets(venue, ' Doge '))).toEqual([[null, ['DOGE', 'DOGECOIN', 'BABYDOGE']]])
  })

  it('lists BTC, ETH and SOL first, then the rest by name', () => {
    const venue = [group(null, ['kPEPE', 'SOL', 'ADA', 'ETH', 'BTC', '1000BONK'])]
    expect(names(searchMarkets(venue, ''))).toEqual([[null, ['BTC', 'ETH', 'SOL', '1000BONK', 'ADA', 'kPEPE']]])
    expect(names(searchMarkets([group(null, ['AEVO', 'ENA', 'ETH'])], 'e'))).toEqual([[null, ['ETH', 'ENA', 'AEVO']]])
  })

  it('matches a HIP-3 market on its symbol too, apart from the main market of the same symbol', () => {
    const hyperliquid = [
      group(null, ['ETH', 'BTC']),
      group('XYZ', ['xyz:CRCL', 'xyz:BTC', 'xyz:RCL']),
      group('Paragon', ['para:BTCD']),
    ]
    expect(names(searchMarkets(hyperliquid, 'btc'))).toEqual([
      [null, ['BTC']],
      ['XYZ', ['xyz:BTC']],
      ['Paragon', ['para:BTCD']],
    ])
    expect(names(searchMarkets(hyperliquid, 'rcl'))).toEqual([['XYZ', ['xyz:RCL', 'xyz:CRCL']]])
    expect(names(searchMarkets(hyperliquid, 'rc'))).toEqual([['XYZ', ['xyz:RCL', 'xyz:CRCL']]])
    expect(names(searchMarkets(hyperliquid, 'xyz'))).toEqual([['XYZ', ['xyz:BTC', 'xyz:CRCL', 'xyz:RCL']]])
  })

  it('puts an exact name ahead of a pinned market that starts with it', () => {
    expect(names(searchMarkets([group(null, ['SOL', 'S'])], 's'))).toEqual([[null, ['S', 'SOL']]])
  })

  it('orders names case aside, so kPEPE comes before LINK, and by code point only when they differ in case alone', () => {
    expect(names(searchMarkets([group(null, ['LINK', 'kPEPE'])], ''))).toEqual([[null, ['kPEPE', 'LINK']]])
    for (const bases of [
      ['kPEPE', 'KPEPE'],
      ['KPEPE', 'kPEPE'],
    ])
      expect(names(searchMarkets([group(null, bases)], ''))).toEqual([[null, ['KPEPE', 'kPEPE']]])
  })

  it('finds a HIP-3 market by the middle of its dex prefix', () => {
    expect(names(searchMarkets([group('XYZ', ['xyz:TSLA'])], 'yz'))).toEqual([['XYZ', ['xyz:TSLA']]])
  })

  it('says nothing matches with no group at all', () => {
    expect(searchMarkets([group(null, ['BTC', 'ETH'])], 'zzzz')).toEqual([])
  })

  it('gives the same list whatever order the venue sends its markets in', () => {
    const letters = fc.constantFrom('A', 'a', 'K', 'k', '1')
    const base = fc.array(letters, { minLength: 1, maxLength: 3 }).map((chars) => chars.join(''))
    const query = fc.array(letters, { maxLength: 1 }).map((chars) => chars.join(''))
    fc.assert(
      fc.property(fc.uniqueArray(base, { maxLength: 8 }), query, (bases, typed) => {
        expect(names(searchMarkets([group(null, [...bases].reverse())], typed))).toEqual(
          names(searchMarkets([group(null, bases)], typed)),
        )
      }),
    )
  })

  it('returns each market that holds the query once, and only those', () => {
    const letters = fc.constantFrom('A', 'B', 'C', 'k', '1')
    const base = fc.array(letters, { minLength: 1, maxLength: 4 }).map((chars) => chars.join(''))
    const groups = fc.array(fc.uniqueArray(base, { maxLength: 8 }), { maxLength: 3 })
    const query = fc.array(letters, { maxLength: 2 }).map((chars) => chars.join(''))
    fc.assert(
      fc.property(groups, query, (lists, typed) => {
        const found = searchMarkets(
          lists.map((bases, index) => group(`dex ${index}`, bases)),
          typed,
        ).flatMap((marketGroup) => marketGroup.markets.map((market) => `${marketGroup.name}/${market.base}`))
        const holding = lists.flatMap((bases, index) =>
          bases
            .filter((name) => name.toUpperCase().includes(typed.toUpperCase()))
            .map((name) => `dex ${index}/${name}`),
        )
        expect([...found].sort()).toEqual([...holding].sort())
      }),
    )
  })
})
