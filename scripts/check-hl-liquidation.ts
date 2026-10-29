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
const tables = new Map(meta.marginTables.map(([id, t]) => [id, t.marginTiers]))
const tiersOf = new Map<string, MarginTier[]>(
  meta.universe.map((u) => [
    u.name,
    (tables.get(u.marginTableId) ?? [{ lowerBound: '0', maxLeverage: u.maxLeverage }]).map((t) => ({
      lowerBound: Number(t.lowerBound),
      maxLeverage: t.maxLeverage,
    })),
  ]),
)

const board = (await (await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')).json()) as {
  leaderboardRows: { ethAddress: string; accountValue: string }[]
}
const rows = board.leaderboardRows.filter((r) => Number(r.accountValue) > 1_000)
const picked = Array.from({ length: count }, (_, i) => rows[Math.floor((i * rows.length) / count)]!)

const errors: number[] = []
const skipped: Record<string, number> = {}
let noPrice = 0
for (const { ethAddress: user } of picked) {
  const [mode, state] = await Promise.all([
    info<string>({ type: 'userAbstraction', user }),
    info<State>({ type: 'clearinghouseState', user }),
  ])
  for (const { position: p } of state.assetPositions) {
    const why =
      mode === 'unifiedAccount' || mode === 'portfolioMargin' ? mode : p.leverage.type !== 'cross' ? 'isolated' : null
    if (why) {
      skipped[why] = (skipped[why] ?? 0) + 1
      continue
    }
    const tiers = tiersOf.get(p.coin)!
    const size = Number(p.szi)
    const value = Number(p.positionValue)
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
    if (!p.liquidationPx) {
      noPrice += 1
      if (ours.kind !== 'none') console.log('venue has no price, ours does', user, p.coin, ours)
      errors.push(ours.kind === 'none' ? 0 : Infinity)
      continue
    }
    const venue = Number(p.liquidationPx)
    const err = ours.kind === 'price' ? Math.abs(ours.px - venue) / venue : Infinity
    errors.push(err)
    if (err > 0.001) console.log('off by more than 0.1%', user, p.coin, mode, { venue, ours })
  }
}

errors.sort((a, b) => a - b)
const pct = (q: number) => `${((errors[Math.floor(q * (errors.length - 1))] ?? NaN) * 100).toFixed(4)}%`
console.log({
  accounts: picked.length,
  positions: errors.length,
  noPrice,
  median: pct(0.5),
  p95: pct(0.95),
  max: pct(1),
  skipped,
})
