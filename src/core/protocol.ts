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
  const fields = value as Record<string, unknown>
  if (fields.kind === 'compare')
    return typeof fields.base === 'string' && isBase(fields.base) ? { kind: 'compare', base: fields.base } : null
  const market = typeof fields.market === 'string' ? parseMarketKey(fields.market) : null
  if (!market) return null
  switch (fields.kind) {
    case 'book':
      return typeof fields.group === 'string' ? { kind: 'book', market, group: fields.group } : null
    case 'depth':
    case 'trades':
      return { kind: fields.kind, market }
    case 'candle':
      return typeof fields.interval === 'string' && isInterval(fields.interval)
        ? { kind: 'candle', market, interval: fields.interval }
        : null
    default:
      return null
  }
}

export function parseTabMessage(data: unknown): TabToHub | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  switch (message.t) {
    case 'hello':
      return typeof message.tab === 'string' && typeof message.visible === 'boolean'
        ? { t: 'hello', tab: message.tab as TabId, visible: message.visible }
        : null
    case 'want':
      return Array.isArray(message.topics)
        ? { t: 'want', topics: message.topics.map(parseTopic).filter((topic): topic is Topic => topic !== null) }
        : null
    case 'visible':
      return typeof message.visible === 'boolean' ? { t: 'visible', visible: message.visible } : null
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}
