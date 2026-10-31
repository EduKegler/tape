import { describe, expect, it } from 'vitest'
import type { Base } from '@tape/core/ids'
import { readHyperliquidMarket, readHyperliquidMarkets } from './markets'

const INFO = 'https://api.hyperliquid.xyz/info'

const answering =
  (bodies: Record<string, unknown>): typeof fetch =>
  async (_, init) =>
    Response.json(bodies[(JSON.parse(init?.body as string) as { type: string }).type])

describe('hyperliquid markets', () => {
  it('keeps a HIP-3 market apart from the main dex market of the same symbol', async () => {
    const groups = await readHyperliquidMarkets(
      answering({
        allPerpMetas: [
          { universe: [{ name: 'STX', szDecimals: 1 }], collateralToken: 0 },
          { universe: [{ name: 'para:STX', szDecimals: 3 }], collateralToken: 0 },
        ],
        perpDexs: [null, { name: 'para', fullName: 'Paragon' }],
      }),
      INFO,
    )
    expect(groups.map((g) => [g.name, g.markets.map((m) => [m.key, m.venueSymbol, m.scale])])).toEqual([
      [null, [['hyperliquid:STX', 'STX', { px: 5, qty: 1 }]]],
      ['Paragon', [['hyperliquid:para:STX', 'para:STX', { px: 3, qty: 3 }]]],
    ])
  })

  it('leaves out a HIP-3 dex settled in a token other than USDC', async () => {
    const groups = await readHyperliquidMarkets(
      answering({
        allPerpMetas: [
          { universe: [{ name: 'BTC', szDecimals: 5 }], collateralToken: 0 },
          { universe: [{ name: 'flx:TSLA', szDecimals: 2 }], collateralToken: 360 },
        ],
        perpDexs: [null, { name: 'flx', fullName: 'Felix Exchange' }],
      }),
      INFO,
    )
    expect(groups.map((g) => g.name)).toEqual([null])
  })

  it('reads one HIP-3 market from its own dex', async () => {
    const dexes: typeof fetch = async (_, init) =>
      (JSON.parse(init?.body as string) as { dex: string }).dex === 'para'
        ? Response.json({ universe: [{ name: 'para:STX', szDecimals: 3 }], collateralToken: 0 })
        : Response.json({ universe: [{ name: 'STX', szDecimals: 1 }], collateralToken: 0 })
    const spec = await readHyperliquidMarket(dexes, INFO, 'para:STX' as Base)
    expect([spec?.key, spec?.scale]).toEqual(['hyperliquid:para:STX', { px: 3, qty: 3 }])
  })

  it('reads a market on a dex Hyperliquid does not list as null', async () => {
    const unknownDex: typeof fetch = async () => new Response('null', { status: 500 })
    expect(await readHyperliquidMarket(unknownDex, INFO, 'nope:TSLA' as Base)).toBeNull()
  })
})
