import { isBase, isInterval, parseMarketKey } from './ids'
import type { TabId } from './ids'
import type { Frame, Topic } from './topics'

/**
 * Tab and hub talk declaratively. A tab never says "subscribe X". It says "this is everything I
 * want now", so a duplicated or replayed message converges to the same state.
 */
export type TabToHub =
  | { readonly t: 'hello'; readonly tab: TabId; readonly visible: boolean }
  | { readonly t: 'want'; readonly topics: readonly Topic[] }
  /** Hidden tabs keep their streams, so there is no resync on return, but get no frames. */
  | { readonly t: 'visible'; readonly visible: boolean }
  /** pagehide fast path. The Web Lock is the guarantee. */
  | { readonly t: 'bye' }

export type HubMode = 'shared' | 'dedicated'

export interface HubStats {
  readonly mode: HubMode
  readonly tabs: number
  readonly sockets: number
  readonly streams: number
  readonly messagesPerSecond: number
  readonly framesPerSecond: number
}

export type HubToTab =
  | { readonly t: 'frames'; readonly frames: readonly Frame[] }
  | { readonly t: 'stats'; readonly stats: HubStats }

function parseTopic(value: unknown): Topic | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.kind === 'compare') return typeof v.base === 'string' && isBase(v.base) ? { kind: 'compare', base: v.base } : null
  const [venue, base] = typeof v.market === 'string' ? v.market.split(':') : []
  const market = venue && base ? parseMarketKey(venue, base) : null
  if (!market) return null
  switch (v.kind) {
    case 'book':
      return typeof v.group === 'string' ? { kind: 'book', market, group: v.group } : null
    case 'depth':
    case 'trades':
      return { kind: v.kind, market }
    case 'candle':
      return typeof v.interval === 'string' && isInterval(v.interval) ? { kind: 'candle', market, interval: v.interval } : null
    default:
      return null
  }
}

/** The hub's boundary: postMessage data is unknown until this says otherwise. */
export function parseTabMessage(data: unknown): TabToHub | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  switch (m.t) {
    case 'hello':
      return typeof m.tab === 'string' && typeof m.visible === 'boolean' ? { t: 'hello', tab: m.tab as TabId, visible: m.visible } : null
    case 'want':
      return Array.isArray(m.topics) ? { t: 'want', topics: m.topics.map(parseTopic).filter((x): x is Topic => x !== null) } : null
    case 'visible':
      return typeof m.visible === 'boolean' ? { t: 'visible', visible: m.visible } : null
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}
