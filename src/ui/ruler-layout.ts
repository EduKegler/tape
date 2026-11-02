export const RULER = { width: 340, height: 100, inset: 8, track: 50, chip: 78, chipGap: 6 } as const

export type Domain = readonly [low: number, high: number]

const PAD = 0.16
const MIN_SPAN = 0.01
const LIQUIDATION_REACH = 0.5
const LIQUIDATION_PAD = 0.4
const EDGE = 0.06

/**
 * The prices the ruler shows: every price of interest with room on both sides, at least 1% of now
 * wide. Liquidation joins only when it lies within half that width of an edge, so a far one points
 * off the edge instead of crushing the rest.
 */
export function domainOf(now: number, prices: readonly number[], liquidation: number | null): Domain {
  const shown = [now, ...prices.filter(Number.isFinite)]
  let low = Math.min(...shown)
  let high = Math.max(...shown)
  const span = Math.max(high - low, now * MIN_SPAN)
  const pad = span * PAD
  low -= pad
  high += pad
  if (
    liquidation !== null
    && liquidation > low - span * LIQUIDATION_REACH
    && liquidation < high + span * LIQUIDATION_REACH
  ) {
    low = Math.min(low, liquidation - pad * LIQUIDATION_PAD)
    high = Math.max(high, liquidation + pad * LIQUIDATION_PAD)
  }
  return [low, high]
}

const usable = RULER.width - RULER.inset * 2

export const toX = ([low, high]: Domain, price: number) => RULER.inset + ((price - low) / (high - low)) * usable

export const clampX = (along: number) => Math.min(RULER.width - RULER.inset, Math.max(RULER.inset, along))

/** The price under `fraction` of the ruler's drawn width, held to the track's ends. */
export function priceAt([low, high]: Domain, fraction: number) {
  const along = Math.min(1, Math.max(0, (fraction * RULER.width - RULER.inset) / usable))
  return low + along * (high - low)
}

export const inDomain = ([low, high]: Domain, price: number) => price >= low && price <= high

/** A handle let go this close to an edge stretches the ruler so the next drag can go on. */
export function nearEdge([low, high]: Domain, price: number) {
  const margin = (high - low) * EDGE
  return price < low + margin || price > high - margin
}

/** Characters to user units for the 11px ruler labels, plus breathing room. */
export const halfWidth = (label: string) => label.length * 2.9 + 4

const LANE_GAP = 4

/**
 * Labels under the track, centered on their mark and held inside the ruler, each in the first of
 * two lanes where it does not touch the label before it. A second-lane label is `crossed` when its
 * leader would run through a first-lane label.
 */
export function laneLabels<TMark extends { readonly at: number; readonly half: number }>(
  marks: readonly TMark[],
): readonly (TMark & { readonly center: number; readonly lane: 0 | 1; readonly crossed: boolean })[] {
  const ends = [-Infinity, -Infinity]
  const placed = [...marks]
    .sort((left, right) => left.at - right.at)
    .map((mark) => {
      const center = Math.min(RULER.width - mark.half, Math.max(mark.half, mark.at))
      const lane: 0 | 1 = center - mark.half > ends[0]! + LANE_GAP ? 0 : 1
      ends[lane] = center + mark.half
      return { ...mark, center, lane }
    })
  const firstLane = placed.filter((mark) => mark.lane === 0)
  return placed.map((mark) => ({
    ...mark,
    crossed: mark.lane === 1 && firstLane.some((other) => Math.abs(mark.at - other.center) <= other.half),
  }))
}

/** Chip centers over their handles, pushed apart so two chips never overlap, and kept inside the ruler. */
export function spreadChips(handles: readonly number[]): readonly number[] {
  const half = RULER.chip / 2
  const order = handles.map((at, index) => ({ at, index })).sort((left, right) => left.at - right.at)
  const centers = order.map(({ at }) => Math.min(RULER.width - half, Math.max(half, at)))
  for (let index = 1; index < centers.length; index += 1) {
    const gap = RULER.chip + RULER.chipGap - (centers[index]! - centers[index - 1]!)
    if (gap > 0) {
      centers[index - 1] = Math.max(half, centers[index - 1]! - gap / 2)
      centers[index] = Math.min(RULER.width - half, centers[index - 1]! + RULER.chip + RULER.chipGap)
    }
  }
  const placed: number[] = []
  order.forEach(({ index }, sorted) => {
    placed[index] = centers[sorted]!
  })
  return placed
}
