import { isBase, isInterval, parseMarketKey } from '@tape/core/ids'
import type { TabId } from '@tape/core/ids'
import type { ExceptionEvent } from '#/analytics/exception'
import type { Frame, Topic } from './topics'

export type TabToHub =
  | { readonly t: 'hello'; readonly tab: TabId; readonly visible: boolean }
  | { readonly t: 'want'; readonly topics: readonly Topic[] }
  | { readonly t: 'visible'; readonly visible: boolean }
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
  | { readonly t: 'exception'; readonly event: ExceptionEvent }

function parseTopic(value: unknown): Topic | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.kind === 'compare')
    return typeof v.base === 'string' && isBase(v.base) ? { kind: 'compare', base: v.base } : null
  const market = typeof v.market === 'string' ? parseMarketKey(v.market) : null
  if (!market) return null
  switch (v.kind) {
    case 'book':
      return typeof v.group === 'string' ? { kind: 'book', market, group: v.group } : null
    case 'depth':
    case 'trades':
      return { kind: v.kind, market }
    case 'candle':
      return typeof v.interval === 'string' && isInterval(v.interval)
        ? { kind: 'candle', market, interval: v.interval }
        : null
    default:
      return null
  }
}

export function parseTabMessage(data: unknown): TabToHub | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  switch (m.t) {
    case 'hello':
      return typeof m.tab === 'string' && typeof m.visible === 'boolean'
        ? { t: 'hello', tab: m.tab as TabId, visible: m.visible }
        : null
    case 'want':
      return Array.isArray(m.topics)
        ? { t: 'want', topics: m.topics.map(parseTopic).filter((x): x is Topic => x !== null) }
        : null
    case 'visible':
      return typeof m.visible === 'boolean' ? { t: 'visible', visible: m.visible } : null
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}
