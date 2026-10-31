import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Base } from './ids'
import type { MarketGroup, MarketSpec } from './market'
import { searchMarkets } from './search'

const spec = (base: string) => ({ base: base as Base }) as MarketSpec
const group = (name: string | null, bases: string[]): MarketGroup => ({ name, markets: bases.map(spec) })
const names = (groups: readonly MarketGroup[]) => groups.map((g) => [g.name, g.markets.map((m) => m.base)])

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

  it('says nothing matches with no group at all', () => {
    expect(searchMarkets([group(null, ['BTC', 'ETH'])], 'zzzz')).toEqual([])
  })

  it('returns each market that holds the query once, and only those', () => {
    const letters = fc.constantFrom('A', 'B', 'C', 'k', '1')
    const base = fc.array(letters, { minLength: 1, maxLength: 4 }).map((l) => l.join(''))
    const groups = fc.array(fc.uniqueArray(base, { maxLength: 8 }), { maxLength: 3 })
    const query = fc.array(letters, { maxLength: 2 }).map((l) => l.join(''))
    fc.assert(
      fc.property(groups, query, (lists, q) => {
        const found = searchMarkets(
          lists.map((bases, i) => group(`dex ${i}`, bases)),
          q,
        ).flatMap((g) => g.markets.map((m) => `${g.name}/${m.base}`))
        const holding = lists.flatMap((bases, i) =>
          bases.filter((b) => b.toUpperCase().includes(q.toUpperCase())).map((b) => `dex ${i}/${b}`),
        )
        expect([...found].sort()).toEqual([...holding].sort())
      }),
    )
  })
})
