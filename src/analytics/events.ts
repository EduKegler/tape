import { z } from 'zod'
import { VENUE_IDS } from '@tape/core/ids'
import type { Command, StepId, Tif, TradeError } from '@tape/trade/types'
import { MAX_EVENTS } from './beacon'
import { CHUNK_ID } from './exception'

/** Keyed records so a new step or error kind fails the build until it is listed here. */
const STEPS = {
  'register-account': true,
  'approve-agent': true,
  'approve-builder': true,
  'derive-key': true,
  'add-key': true,
} satisfies Record<StepId, true>

const ERRORS = {
  'wallet-rejected': true,
  'needs-setup': true,
  'no-account': true,
  'insufficient-margin': true,
  'invalid-order': true,
  rejected: true,
  'rate-limited': true,
  unsupported: true,
  unreachable: true,
  'unknown-outcome': true,
  unexpected: true,
} satisfies Record<TradeError['kind'], true>

const COMMANDS = { place: true, cancel: true, 'cancel-all': true, leverage: true } satisfies Record<
  Command['kind'],
  true
>

const TIFS = { gtc: true, ioc: true, 'post-only': true } satisfies Record<Tif, true>

const keys = <TKey extends string>(record: Record<TKey, true>) => Object.keys(record) as [TKey, ...TKey[]]

const venue = z.enum(VENUE_IDS)
const error = z.enum(keys(ERRORS))
const command = z.enum(keys(COMMANDS))
const connector = z.enum(['injected', 'walletConnect', 'other'])

const frame = z.strictObject({
  file: z
    .url({ protocol: /^https?$/ })
    .max(300)
    .regex(/^[^?#]*$/),
  fn: z.string().max(100),
  line: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  chunk: z.string().regex(CHUNK_ID).optional(),
})

/** Every event the page may send, with every property it may carry. Nothing else reaches PostHog. */
export const AppEvent = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('$pageview'),
    path: z.string().startsWith('/').max(200),
    referrer: z.url().max(200).optional(),
  }),
  z.strictObject({ event: z.literal('wallet_connected'), connector }),
  z.strictObject({
    event: z.literal('wallet_connect_failed'),
    connector,
    reason: z.enum(['no-wallet', 'rejected', 'other']),
  }),
  z.strictObject({ event: z.literal('trading_enable_started'), venue }),
  /** Sent when the wallet is asked for the step. The next step or `trading_enabled` is what shows it passed. */
  z.strictObject({ event: z.literal('trading_enable_step'), venue, step: z.enum(keys(STEPS)) }),
  z.strictObject({ event: z.literal('trading_enabled'), venue }),
  z.strictObject({ event: z.literal('trading_enable_failed'), venue, error }),
  z.strictObject({
    event: z.literal('command_sent'),
    venue,
    command,
    side: z.enum(['buy', 'sell']).optional(),
    order: z.enum(['limit', 'market', 'scale']).optional(),
    tif: z.enum(keys(TIFS)).optional(),
    reduce_only: z.boolean().optional(),
  }),
  z.strictObject({
    event: z.literal('command_result'),
    venue,
    command,
    result: z.enum(['placed', 'done', 'failed']),
    status: z.enum(['resting', 'filled', 'accepted']).optional(),
    error: error.optional(),
  }),
  z.strictObject({ event: z.literal('order_lookup'), venue, found: z.boolean() }),
  /** PostHog error tracking reads frames oldest call first. */
  z.strictObject({
    event: z.literal('$exception'),
    type: z.string().max(100),
    value: z.string().max(500),
    handled: z.boolean(),
    source: z.enum(['window', 'promise', 'router', 'trade', 'hub']),
    frames: z.array(frame).min(1).max(20),
  }),
])
export type AppEvent = z.infer<typeof AppEvent>

/** What the page posts: one page load's id and the events it queued, each after the client time it happened. */
export const Batch = z.strictObject({
  session: z.uuid({ version: 'v7' }),
  events: z
    .array(z.tuple([z.number().int().positive(), AppEvent]))
    .min(1)
    .max(MAX_EVENTS),
})
export type Batch = z.infer<typeof Batch>
