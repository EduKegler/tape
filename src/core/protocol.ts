import { isBase, isInterval, isTabId, parseMarketKey } from '@tape/core/ids'
import type { TabId } from '@tape/core/ids'
import { isRecord } from '@tape/core/json'
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

function parseTopic(fields: unknown): Topic | null {
  if (!isRecord(fields)) return null
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

export function parseTabMessage(message: unknown): TabToHub | null {
  if (!isRecord(message)) return null
  switch (message.t) {
    case 'hello':
      return typeof message.tab === 'string' && isTabId(message.tab) && typeof message.visible === 'boolean'
        ? { t: 'hello', tab: message.tab, visible: message.visible }
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
