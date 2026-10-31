import { PINNED_BASES } from './ids'
import type { Base } from './ids'
import type { MarketGroup, MarketSpec } from './market'

const EXACT = 0
const PREFIX = 1
const SUBSTRING = 2

function matchOf(base: Base, query: string): number | null {
  const name = base.toUpperCase()
  if (name === query) return EXACT
  if (name.startsWith(query)) return PREFIX
  if (name.includes(query)) return SUBSTRING
  return null
}

const pinOf = (base: Base) => {
  const at = PINNED_BASES.indexOf(base)
  return at === -1 ? PINNED_BASES.length : at
}

const byName = (a: Base, b: Base) => {
  const [ua, ub] = [a.toUpperCase(), b.toUpperCase()]
  if (ua !== ub) return ua < ub ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The markets whose name holds `query`, in their groups, case aside. Each group lists an exact
 * name first, then names that start with the query, then names that contain it, with BTC, ETH and
 * SOL ahead within each of those and the rest by name. Groups keep their order, and a group with no
 * match drops out.
 */
export function searchMarkets(groups: readonly MarketGroup[], query: string): readonly MarketGroup[] {
  const q = query.trim().toUpperCase()
  return groups.flatMap((group) => {
    const hits = group.markets.flatMap((spec) => {
      const match = matchOf(spec.base, q)
      return match === null ? [] : [{ spec, match, pin: pinOf(spec.base) }]
    })
    hits.sort((a, b) => a.match - b.match || a.pin - b.pin || byName(a.spec.base, b.spec.base))
    const markets: readonly MarketSpec[] = hits.map((h) => h.spec)
    return markets.length ? [{ name: group.name, markets }] : []
  })
}
