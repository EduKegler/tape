import { useState } from 'react'
import { useSelector } from '@tanstack/react-store'
import { parsePx, parseQty } from '@tape/core/fixed'
import { priceTick } from '@tape/core/market'
import type { MarketSpec } from '@tape/core/market'
import { checkCloseSize, checkPrice, closeIntent, closeTif } from '@tape/trade/intent'
import type { CloseExit } from '@tape/trade/intent'
import {
  checkStopLoss,
  closeShare,
  keptAfter,
  leverageOf,
  nearestTick,
  pnlAt,
  priceForRoe,
  roeOf,
} from '@tape/trade/position'
import { checkProtect, protectIntent } from '@tape/trade/protect'
import type { ExitWish } from '@tape/trade/protect'
import type { AccountRef, Capabilities, OpenOrder, OrderExit, Position } from '@tape/trade/types'
import { useTradeCommands } from '#/trade/hooks'
import { Segmented } from './Panel'
import { Button, UnitInput } from './primitives'
import { Ruler } from './Ruler'
import type { RulerHandle } from './Ruler'
import { domainOf } from './ruler-layout'
import type { Domain } from './ruler-layout'
import { ErrorMark } from './ErrorMark'
import { OrderNote } from './TradeNote'
import { formatSigned } from './format'
import { armedLeg, plainPrice, shownPrice, typed, useTouch } from './manage'
import type { Touch } from './manage'
import { closeSlippageBps } from './ticket-store'

export type PositionTab = 'protect' | 'close'

const GHOST_ROE = 25
const GHOST_MOVE = 0.02
const KEY_TICKS = 5
const SHARES = [25, 50, 75, 100] as const
const LEGS = ['tp', 'sl'] as const

type Leg = OrderExit['kind']
type Ctx = {
  readonly account: AccountRef
  readonly venue: string
  readonly position: Position
  readonly spec: MarketSpec
  readonly caps: Capabilities
  readonly orders: readonly OpenOrder[]
}

const held = (spec: MarketSpec, position: Position) => Math.abs(Number(position.size)).toFixed(spec.scale.qty)
const tone = (value: number | null) => (value === null ? '' : value >= 0 ? 'text-bid' : 'text-ask')
const finite = (value: number) => (Number.isFinite(value) ? value : null)

export function PositionPanel({
  tab,
  onTab,
  ...ctx
}: Ctx & { readonly tab: PositionTab; readonly onTab: (tab: PositionTab) => void }) {
  const touch = useTouch(ctx.spec)
  return (
    <>
      <div className="flex px-3 pt-2">
        <Segmented
          pills="small"
          label="Manage position"
          value={tab}
          onChange={onTab}
          options={[
            { value: 'protect', label: 'TP / SL' },
            { value: 'close', label: 'Close' },
          ]}
        />
      </div>
      {tab === 'protect' ? (
        <Protect key="protect" {...ctx} touch={touch} />
      ) : (
        <Close key="close" {...ctx} touch={touch} />
      )}
    </>
  )
}

function useScene({ position, spec, orders }: Ctx, touch: Touch | null) {
  const now = touch?.mid ?? Number(position.mark ?? position.entry)
  const liquidation = position.liquidation === null ? null : Number(position.liquidation)
  const fixed = [
    Number(position.entry),
    ...orders
      .filter((order) => order.symbol === spec.venueSymbol && order.px !== null)
      .map((order) => Number(order.px)),
    ...[GHOST_ROE, -GHOST_ROE].flatMap((roe) => {
      const px = priceForRoe(spec, position, roe)
      return px === null ? [] : [px / 10 ** spec.scale.px]
    }),
  ]
  const fit = (extra: readonly number[]) => domainOf(now, [...fixed, ...extra], liquidation)
  const [domain, setDomain] = useState<Domain>(() => fit([]))
  return {
    now,
    liquidation,
    domain,
    widen: (extra: readonly number[]) => setDomain(fit(extra)),
    format: (price: number) => shownPrice(spec, price),
    snap: (price: number) => nearestTick(spec, price) / 10 ** spec.scale.px,
    keyStep: (priceTick(spec, nearestTick(spec, now)) / 10 ** spec.scale.px) * KEY_TICKS,
    dots: orders
      .filter((order) => order.symbol === spec.venueSymbol && order.exit === null && order.px !== null)
      .map((order) => ({ price: Number(order.px), side: order.side })),
  }
}

function legCheck(ctx: Ctx, touch: Touch | null, leg: Leg, text: string) {
  if (!text) return { error: undefined, warning: undefined }
  const error = checkPrice(ctx.spec, text)
  if (error) return { error, warning: undefined }
  const px = parsePx(text, ctx.spec.scale)
  const wish: ExitWish = { kind: 'set', px }
  const keep: ExitWish = { kind: 'keep' }
  const book = touch
    ? {
        bid: parsePx(plainPrice(ctx.spec, touch.bid), ctx.spec.scale),
        ask: parsePx(plainPrice(ctx.spec, touch.ask), ctx.spec.scale),
      }
    : { bid: null, ask: null }
  const errors = checkProtect(ctx.position.side, book, {
    takeProfit: leg === 'tp' ? wish : keep,
    stopLoss: leg === 'sl' ? wish : keep,
  })
  const direction = leg === 'tp' ? errors.takeProfit : errors.stopLoss
  return {
    error: direction,
    warning: !direction && leg === 'sl' ? checkStopLoss(ctx.position, px, ctx.spec.scale.px) : undefined,
  }
}

function Protect(ctx: Ctx & { readonly touch: Touch | null }) {
  const { position, spec, caps, orders, touch } = ctx
  const { run, last, inFlight } = useTradeCommands(ctx.account)
  const scene = useScene(ctx, touch)
  const armed = {
    tp: armedLeg(orders, spec.venueSymbol, 'tp', caps),
    sl: armedLeg(orders, spec.venueSymbol, 'sl', caps),
  }
  const leverage = leverageOf(position)
  const roeText = (price: number) => {
    const roe = roeOf(position, pnlAt(position, price))
    return roe === null ? '' : roe.toFixed(Math.abs(roe) >= 100 ? 0 : 1)
  }
  const start = (leg: Leg) => (armed[leg] ? plainPrice(spec, Number(armed[leg].px)) : '')
  const [draft, setDraft] = useState(() => ({
    tp: start('tp'),
    sl: start('sl'),
    tpRoe: armed.tp ? roeText(Number(armed.tp.px)) : '',
    slRoe: armed.sl ? roeText(Number(armed.sl.px)) : '',
  }))
  const busy = last.pending || inFlight.length > 0
  const setPrice = (leg: Leg, text: string) => {
    const price = typed(text)
    setDraft((before) => ({ ...before, [leg]: text, [`${leg}Roe`]: Number.isFinite(price) ? roeText(price) : '' }))
    if (Number.isFinite(price) && (price < scene.domain[0] || price > scene.domain[1])) scene.widen([price])
  }
  const setRoe = (leg: Leg, text: string) => {
    const roe = typed(text)
    const px = Number.isFinite(roe) ? priceForRoe(spec, position, roe) : null
    const price = px === null ? null : px / 10 ** spec.scale.px
    setDraft((before) => ({ ...before, [`${leg}Roe`]: text, [leg]: price === null ? '' : plainPrice(spec, price) }))
    if (price !== null && (price < scene.domain[0] || price > scene.domain[1])) scene.widen([price])
  }
  const checks = { tp: legCheck(ctx, touch, 'tp', draft.tp), sl: legCheck(ctx, touch, 'sl', draft.sl) }
  const changed = LEGS.filter((leg) => {
    const price = typed(draft[leg])
    return (
      Number.isFinite(price) && !checkPrice(spec, draft[leg]) && price !== (armed[leg] ? Number(armed[leg].px) : null)
    )
  })
  const bad = LEGS.some((leg) => checks[leg].error)
  const wishOf = (leg: Leg): ExitWish =>
    changed.includes(leg) ? { kind: 'set', px: parsePx(draft[leg], spec.scale) } : { kind: 'keep' }
  const send = (wishes: { takeProfit: ExitWish; stopLoss: ExitWish }) =>
    run({ kind: 'protect', intent: protectIntent(spec, position, orders, caps, wishes) })
  const remove = (leg: Leg) => {
    send({
      takeProfit: leg === 'tp' ? { kind: 'remove' } : { kind: 'keep' },
      stopLoss: leg === 'sl' ? { kind: 'remove' } : { kind: 'keep' },
    })
    setDraft((before) => ({ ...before, [leg]: '', [`${leg}Roe`]: '' }))
  }
  const ghost = (leg: Leg) => {
    const roe = priceForRoe(spec, position, leg === 'tp' ? GHOST_ROE : -GHOST_ROE)
    if (roe !== null) return roe / 10 ** spec.scale.px
    const gain = (leg === 'tp') === (position.side === 'long') ? 1 : -1
    return scene.snap(scene.now * (1 + gain * GHOST_MOVE))
  }
  const handles: RulerHandle[] = LEGS.map((leg) => {
    const price = finite(typed(draft[leg]))
    const pnl = price === null ? null : pnlAt(position, price)
    return {
      key: leg,
      price,
      ghost: ghost(leg),
      short: leg.toUpperCase(),
      label: leg === 'tp' ? 'Take profit' : 'Stop loss',
      grip: leg,
      outcome: pnl === null ? null : formatSigned(pnl),
      gain: pnl === null ? null : pnl >= 0,
      bad: Boolean(checks[leg].error),
    }
  })
  const replacing = changed.some((leg) => armed[leg])
  const each = caps.wholeExits
    ? 'Each closes the whole position at market.'
    : `Each closes ${held(spec, position)} ${spec.base} at market, the size held now.`
  return (
    <>
      <Ruler
        label={`${spec.base} price ruler, lower prices on the left`}
        domain={scene.domain}
        format={scene.format}
        snap={scene.snap}
        keyStep={scene.keyStep}
        now={scene.now}
        entry={Number(position.entry)}
        liquidation={scene.liquidation}
        zones={handles.flatMap((handle) =>
          handle.price === null
            ? []
            : [{ from: Number(position.entry), to: handle.price, gain: pnlAt(position, handle.price) >= 0 }],
        )}
        dots={scene.dots}
        legs={[]}
        handles={handles}
        onMove={(key, price) => setPrice(key === 'tp' ? 'tp' : 'sl', plainPrice(spec, price))}
        onRelease={(price) => scene.widen([price])}
        onTrack={(price) => (price > scene.now === (position.side === 'long') ? 'tp' : 'sl')}
      />
      <p className="px-3 pt-1 text-xs text-level3">Drag TP or SL, or click the line to place one. {each}</p>
      <div className="flex flex-col gap-2.5 px-3 pt-2.5 pb-3">
        {LEGS.map((leg) => {
          const word = leg === 'tp' ? 'Take profit' : 'Stop loss'
          const price = finite(typed(draft[leg]))
          const pnl = price === null ? null : pnlAt(position, price)
          const check = checks[leg]
          const standing = armed[leg]
          return (
            <div key={leg} className="flex flex-col gap-1">
              <div className="flex items-center">
                <span className="w-22.5 shrink-0 text-sm font-medium text-level1">{word}</span>
                <div className="flex min-w-0 flex-1 gap-2">
                  <UnitInput
                    label={`${word} price`}
                    unit={spec.quote}
                    placeholder="Price"
                    value={draft[leg]}
                    aria-invalid={Boolean(check.error)}
                    onChange={(event) => setPrice(leg, event.target.value.trim())}
                    className="flex-1"
                  />
                  {leverage !== null && (
                    <UnitInput
                      label={`${word} return on margin`}
                      unit="% ROE"
                      placeholder={leg === 'tp' ? `+${GHOST_ROE}` : `-${GHOST_ROE}`}
                      value={draft[`${leg}Roe`]}
                      onChange={(event) => setRoe(leg, event.target.value.trim())}
                      className="w-28"
                    />
                  )}
                </div>
              </div>
              <div className="flex text-xs text-level3">
                <span className="w-22.5 shrink-0" />
                <div className="flex flex-1 justify-between gap-2">
                  {check.error ? (
                    <span className="flex items-center gap-1 text-level1">
                      <ErrorMark className="size-3 shrink-0" />
                      {check.error}
                    </span>
                  ) : check.warning ? (
                    <span className="text-warn">{check.warning}</span>
                  ) : (
                    <span>
                      {leg === 'tp' ? 'Profit ' : 'Loss '}
                      <span className={`num ${tone(pnl)}`}>
                        {pnl === null ? '—' : `${formatSigned(pnl)} ${spec.quote}`}
                      </span>
                    </span>
                  )}
                  {standing ? (
                    <span>
                      Armed <span className="num text-level1">{shownPrice(spec, Number(standing.px))}</span> ·{' '}
                      <Button
                        look="inline"
                        disabled={busy}
                        onClick={() => remove(leg)}
                        aria-label={`Cancel ${word.toLowerCase()}`}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span>Not set</span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <OrderNote error={last.error} outcome={last.outcome} lookup={last.lookup} />
        <Button
          look="primary"
          size="tall"
          className="w-full"
          disabled={changed.length === 0 || bad || busy}
          onClick={() => send({ takeProfit: wishOf('tp'), stopLoss: wishOf('sl') })}
        >
          {busy
            ? 'Sending…'
            : changed.length > 0
              ? `${replacing ? 'Replace' : 'Set'} ${changed.map((leg) => `${leg.toUpperCase()} ${shownPrice(spec, typed(draft[leg]))}`).join(' and ')}`
              : 'Set TP/SL'}
        </Button>
      </div>
    </>
  )
}

type How = 'market' | 'limit' | 'mid'

function Close(ctx: Ctx & { readonly touch: Touch | null }) {
  const { position, spec, caps, orders, touch } = ctx
  const { run, last, inFlight } = useTradeCommands(ctx.account)
  const slippage = useSelector(closeSlippageBps, (state) => state)
  const scene = useScene(ctx, touch)
  const [size, setSize] = useState(() => held(spec, position))
  const [how, setHow] = useState<How>('market')
  const [limit, setLimit] = useState('')
  const busy = last.pending || inFlight.length > 0
  const long = position.side === 'long'
  const sizeError = checkCloseSize(spec, position, size)
  const limitError = how === 'limit' ? (limit ? checkPrice(spec, limit) : 'Drag the limit or type a price') : undefined
  const closing = sizeError ? null : parseQty(size, spec.scale)
  const exitPrice =
    how === 'limit' ? finite(typed(limit)) : touch ? (how === 'mid' ? touch.mid : long ? touch.bid : touch.ask) : null
  const share = closing === null ? 0 : closing / parseQty(held(spec, position), spec.scale)
  const pnl = exitPrice === null || closing === null ? null : pnlAt(position, exitPrice) * share
  const pickLimit = (price: number) => {
    setHow('limit')
    setLimit(plainPrice(spec, price))
  }
  const exit = (): CloseExit | null => {
    if (how === 'market') return { kind: 'market', slippage }
    if (how === 'mid') return { kind: 'mid' }
    return limitError ? null : { kind: 'limit', px: parsePx(limit, spec.scale), tif: closeTif(caps) }
  }
  const kept = closing === null ? null : keptAfter(spec, position, closing)
  const ways: { value: How; label: string }[] = [
    { value: 'market', label: 'Market' },
    { value: 'limit', label: 'Limit' },
    ...(caps.restingReduceOnly ? [{ value: 'mid' as const, label: 'Mid' }] : []),
  ]
  const error = sizeError ?? limitError
  const at = how === 'limit' ? `at ${limitError ? '' : shownPrice(spec, typed(limit))}` : `at ${how}`
  const armed = (['tp', 'sl'] as const).flatMap((leg) => {
    const order = armedLeg(orders, spec.venueSymbol, leg, caps)
    return order
      ? [{ price: Number(order.px), label: `${leg.toUpperCase()} ${shownPrice(spec, Number(order.px))}` }]
      : []
  })
  return (
    <>
      <Ruler
        label={`${spec.base} price ruler, lower prices on the left`}
        domain={scene.domain}
        format={scene.format}
        snap={scene.snap}
        keyStep={scene.keyStep}
        now={scene.now}
        entry={Number(position.entry)}
        liquidation={scene.liquidation}
        exit={
          how === 'limit' || exitPrice === null
            ? null
            : { price: exitPrice, label: `${how === 'mid' ? 'Mid' : 'Exit ~'}${scene.format(exitPrice)}` }
        }
        zones={
          exitPrice === null
            ? []
            : [{ from: Number(position.entry), to: exitPrice, gain: pnlAt(position, exitPrice) >= 0 }]
        }
        dots={scene.dots}
        legs={armed}
        handles={
          how === 'limit'
            ? [
                {
                  key: 'limit',
                  price: finite(typed(limit)),
                  ghost: scene.snap(scene.now),
                  short: 'Limit',
                  label: 'Limit close price',
                  grip: 'ink',
                  outcome: pnl === null ? null : formatSigned(pnl),
                  gain: pnl === null ? null : pnl >= 0,
                  bad: Boolean(limitError && limit),
                },
              ]
            : []
        }
        onMove={(_key, price) => pickLimit(price)}
        onRelease={(price) => scene.widen([price])}
        onTrack={() => {
          setHow('limit')
          return 'limit'
        }}
      />
      <p className="px-3 pt-1 text-xs text-level3">Click the line to close at that price instead.</p>
      <div className="flex flex-col gap-2.5 px-3 pt-2.5 pb-3">
        <div className="flex items-center gap-2">
          <UnitInput
            label="Size to close"
            unit={spec.base}
            value={size}
            aria-invalid={Boolean(sizeError)}
            onChange={(event) => setSize(event.target.value.trim())}
            className="w-34"
          />
          <Segmented
            pills="small"
            label="Share of the position"
            value={SHARES.find((percent) => closing === closeShare(spec, position, percent))?.toString() ?? ''}
            onChange={(value) => {
              const qty = closeShare(spec, position, Number(value))
              setSize((qty / 10 ** spec.scale.qty).toFixed(spec.scale.qty))
            }}
            options={SHARES.map((percent) => ({
              value: String(percent),
              label: percent === 100 ? 'All' : `${percent}%`,
            }))}
          />
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            pills="small"
            label="How to close"
            value={how}
            onChange={(value) => {
              setHow(value)
              if (value === 'limit' && !limit) setLimit(plainPrice(spec, scene.now))
            }}
            options={ways}
          />
          {how === 'limit' && (
            <UnitInput
              label="Limit price"
              unit={spec.quote}
              value={limit}
              aria-invalid={Boolean(limitError && limit)}
              onChange={(event) => {
                setLimit(event.target.value.trim())
                const price = typed(event.target.value)
                if (Number.isFinite(price) && (price < scene.domain[0] || price > scene.domain[1])) scene.widen([price])
              }}
              className="w-34"
            />
          )}
        </div>
        {error ? (
          <span className="flex items-center gap-1 text-xs text-level1">
            <ErrorMark className="size-3 shrink-0" />
            {error}
          </span>
        ) : (
          <span className="text-xs text-level3">
            {how === 'market'
              ? `Slippage up to ${slippage / 100}% · `
              : caps.restingReduceOnly
                ? 'Rests as reduce only until it fills · '
                : `Fills now or not at all, ${ctx.venue} rests no reduce-only close · `}
            Keeps {kept === null ? '—' : (kept / 10 ** spec.scale.qty).toFixed(spec.scale.qty)} {spec.base} · Est. PnL{' '}
            <span className={`num ${tone(pnl)}`}>{pnl === null ? '—' : `${formatSigned(pnl)} ${spec.quote}`}</span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <OrderNote error={last.error} outcome={last.outcome} lookup={last.lookup} />
        <Button
          look={long ? 'ask' : 'bid'}
          size="tall"
          className="w-full"
          disabled={Boolean(error) || busy || !exit()}
          onClick={() => {
            const chosen = exit()
            const intent = chosen && closing !== null ? closeIntent(spec, position, chosen, closing) : null
            if (intent) run({ kind: 'place', intent })
          }}
        >
          {busy ? 'Sending…' : error ? 'Close' : `Close ${size} ${spec.base} ${at}`}
        </Button>
      </div>
    </>
  )
}
