import { PINNED_BASES, splitBase } from './ids'
import type { Base } from './ids'
import type { MarketGroup, MarketSpec } from './market'

const EXACT = 0
const PREFIX = 1
const SUBSTRING = 2

function matchOf(base: Base, query: string): number | null {
  const names = [base, splitBase(base).symbol].map((name) => name.toUpperCase())
  if (names.includes(query)) return EXACT
  if (names.some((name) => name.startsWith(query))) return PREFIX
  if (names.some((name) => name.includes(query))) return SUBSTRING
  return null
}

const pinOf = (base: Base) => {
  const at = PINNED_BASES.indexOf(base)
  return at === -1 ? PINNED_BASES.length : at
}

const byName = (left: Base, right: Base) => {
  const [ua, ub] = [left.toUpperCase(), right.toUpperCase()]
  if (ua !== ub) return ua < ub ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The markets whose name holds `query`, in their groups, case aside. Each group lists an exact
 * name first, then names that start with the query, then names that contain it, with BTC, ETH and
 * SOL ahead within each of those and the rest by name. A HIP-3 name such as `xyz:TSLA` also
 * matches on `TSLA`. Groups keep their order, and a group with no match drops out.
 */
export function searchMarkets(groups: readonly MarketGroup[], query: string): readonly MarketGroup[] {
  const needle = query.trim().toUpperCase()
  return groups.flatMap((group) => {
    const hits = group.markets.flatMap((spec) => {
      const match = matchOf(spec.base, needle)
      return match === null ? [] : [{ spec, match, pin: pinOf(spec.base) }]
    })
    hits.sort(
      (left, right) => left.match - right.match || left.pin - right.pin || byName(left.spec.base, right.spec.base),
    )
    const markets: readonly MarketSpec[] = hits.map((hit) => hit.spec)
    return markets.length ? [{ ...group, markets }] : []
  })
}
