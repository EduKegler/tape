import { estimateLiquidation, maintenanceMargin } from '../packages/trade/src/liquidation.ts'
import type { MarginTier } from '../packages/trade/src/liquidation.ts'

const API = 'https://api.hyperliquid.xyz/info'
const info = async <T>(body: unknown): Promise<T> => {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`)
  return (await res.json()) as T
}

type Meta = {
  universe: { name: string; maxLeverage: number; marginTableId: number }[]
  marginTables: [number, { marginTiers: { lowerBound: string; maxLeverage: number }[] }][]
}
type State = {
  crossMarginSummary: { accountValue: string }
  crossMaintenanceMarginUsed: string
  assetPositions: {
    position: {
      coin: string
      szi: string
      positionValue: string
      liquidationPx: string | null
      leverage: { type: string }
    }
  }[]
}

const count = Number(process.argv[2] ?? 40)
const meta = await info<Meta>({ type: 'meta' })
const tables = new Map(meta.marginTables.map(([id, table]) => [id, table.marginTiers]))
const tiersOf = new Map<string, MarginTier[]>(
  meta.universe.map((asset) => [
    asset.name,
    (tables.get(asset.marginTableId) ?? [{ lowerBound: '0', maxLeverage: asset.maxLeverage }]).map((tier) => ({
      lowerBound: Number(tier.lowerBound),
      maxLeverage: tier.maxLeverage,
    })),
  ]),
)

const board = (await (await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')).json()) as {
  leaderboardRows: { ethAddress: string; accountValue: string }[]
}
const rows = board.leaderboardRows.filter((row) => Number(row.accountValue) > 1_000)
const picked = Array.from({ length: count }, (_, index) => rows[Math.floor((index * rows.length) / count)]!)

const errors: number[] = []
const skipped: Record<string, number> = {}
let noPrice = 0
for (const { ethAddress: user } of picked) {
  const [mode, state] = await Promise.all([
    info<string>({ type: 'userAbstraction', user }),
    info<State>({ type: 'clearinghouseState', user }),
  ])
  for (const { position } of state.assetPositions) {
    const why =
      mode === 'unifiedAccount' || mode === 'portfolioMargin'
        ? mode
        : position.leverage.type !== 'cross'
          ? 'isolated'
          : null
    if (why) {
      skipped[why] = (skipped[why] ?? 0) + 1
      continue
    }
    const tiers = tiersOf.get(position.coin)!
    const size = Number(position.szi)
    const value = Number(position.positionValue)
    const ours = estimateLiquidation(
      {
        kind: 'cross',
        accountValue: Number(state.crossMarginSummary.accountValue),
        othersMaintenance: Number(state.crossMaintenanceMarginUsed) - maintenanceMargin(tiers, value),
        tiers,
        position: { size, mark: value / Math.abs(size) },
      },
      null,
    )
    if (!position.liquidationPx) {
      noPrice += 1
      if (ours.kind !== 'none') console.log('venue has no price, ours does', user, position.coin, ours)
      errors.push(ours.kind === 'none' ? 0 : Infinity)
      continue
    }
    const venue = Number(position.liquidationPx)
    const err = ours.kind === 'price' ? Math.abs(ours.px - venue) / venue : Infinity
    errors.push(err)
    if (err > 0.001) console.log('off by more than 0.1%', user, position.coin, mode, { venue, ours })
  }
}

errors.sort((left, right) => left - right)
const pct = (quantile: number) => `${((errors[Math.floor(quantile * (errors.length - 1))] ?? NaN) * 100).toFixed(4)}%`
console.log({
  accounts: picked.length,
  positions: errors.length,
  noPrice,
  median: pct(0.5),
  p95: pct(0.95),
  max: pct(1),
  skipped,
})
