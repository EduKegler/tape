import { useState } from 'react'
import { parsePx } from '@tape/core/fixed'
import { priceTick } from '@tape/core/market'
import type { MarketSpec } from '@tape/core/market'
import { checkPrice } from '@tape/trade/intent'
import { moveIntent, nearestTick } from '@tape/trade/position'
import { checkProtect, protectIntent } from '@tape/trade/protect'
import type { ExitWish } from '@tape/trade/protect'
import type { AccountRef, Capabilities, OpenOrder, Position } from '@tape/trade/types'
import { useTradeCommands } from '#/trade/hooks'
import { Button, UnitInput } from './primitives'
import { Ruler } from './Ruler'
import { domainOf } from './ruler-layout'
import type { Domain } from './ruler-layout'
import { ErrorMark } from './ErrorMark'
import { OrderNote } from './TradeNote'
import { ordered, plainPrice, shownPrice, shownSize, typed, useTouch } from './manage'

const KEY_TICKS = 5

const MOVES: Record<AccountRef['venue'], string> = {
  hyperliquid: 'moves it in place',
  orderly: 'edits it in place',
  dydx: 'cancels it and places it again',
}

export function MovePanel({
  account,
  venue,
  order,
  position,
  spec,
  caps,
  orders,
}: {
  account: AccountRef
  venue: string
  order: OpenOrder
  position: Position | null
  spec: MarketSpec
  caps: Capabilities
  orders: readonly OpenOrder[]
}) {
  const touch = useTouch(spec)
  const { run, last, inFlight } = useTradeCommands(account)
  const was = Number(order.px)
  const now = touch?.mid ?? was
  const [price, setPrice] = useState(() => plainPrice(spec, was))
  const [size, setSize] = useState<string>(order.size)
  const fit = (extra: readonly number[]) =>
    domainOf(
      now,
      [was, ...extra, ...(position ? [Number(position.entry)] : [])],
      position?.liquidation ? Number(position.liquidation) : null,
    )
  const [domain, setDomain] = useState<Domain>(() => fit([]))
  const busy = last.pending || inFlight.length > 0
  const exit = order.exit
  const picked = typed(price)
  const priceError = checkPrice(spec, price)
  const legError =
    exit && position && !priceError && touch
      ? (() => {
          const wish: ExitWish = { kind: 'set', px: parsePx(price, spec.scale) }
          const book = {
            bid: parsePx(plainPrice(spec, touch.bid), spec.scale),
            ask: parsePx(plainPrice(spec, touch.ask), spec.scale),
          }
          const errors = checkProtect(position.side, book, {
            takeProfit: exit.kind === 'tp' ? wish : { kind: 'keep' },
            stopLoss: exit.kind === 'sl' ? wish : { kind: 'keep' },
          })
          return exit.kind === 'tp' ? errors.takeProfit : errors.stopLoss
        })()
      : undefined
  const built = exit ? null : moveIntent(spec, order, caps, price, size)
  const sizeError = built && !built.ok ? built.errors.size : undefined
  const error = priceError ?? legError ?? sizeError ?? (built && !built.ok ? built.errors.tif : undefined)
  const changed = picked !== was || (!exit && size !== order.size)
  const widen = (value: number) => {
    if (Number.isFinite(value) && (value < domain[0] || value > domain[1])) setDomain(fit([value]))
  }
  const short = exit ? exit.kind.toUpperCase() : order.side === 'buy' ? 'Buy' : 'Sell'
  const send = () => {
    if (exit && position) {
      const wish: ExitWish = { kind: 'set', px: parsePx(price, spec.scale) }
      run({
        kind: 'protect',
        intent: protectIntent(spec, position, orders, caps, {
          takeProfit: exit.kind === 'tp' ? wish : { kind: 'keep' },
          stopLoss: exit.kind === 'sl' ? wish : { kind: 'keep' },
        }),
      })
    } else if (built?.ok) run({ kind: 'modify', order: order.ref, intent: built.intent })
  }
  return (
    <>
      <Ruler
        label={`${spec.base} price ruler, lower prices on the left`}
        domain={domain}
        format={(value) => shownPrice(spec, value)}
        snap={(value) => nearestTick(spec, value) / 10 ** spec.scale.px}
        keyStep={(priceTick(spec, nearestTick(spec, now)) / 10 ** spec.scale.px) * KEY_TICKS}
        now={now}
        entry={position ? Number(position.entry) : null}
        liquidation={position?.liquidation ? Number(position.liquidation) : null}
        zones={[]}
        dots={orders
          .filter((other) => other.symbol === order.symbol && other.ref !== order.ref && other.px !== null)
          .map((other) => ({ price: Number(other.px), side: other.side }))}
        legs={[]}
        handles={[
          {
            key: 'order',
            price: Number.isFinite(picked) ? picked : null,
            ghost: was,
            short,
            label: `${order.kind} price`,
            grip: exit ? exit.kind : 'ink',
            outcome: picked === was ? 'now here' : `was ${shownPrice(spec, was)}`,
            gain: null,
            bad: Boolean(priceError ?? legError),
          },
        ]}
        onMove={(_key, value) => setPrice(plainPrice(spec, value))}
        onRelease={(value) => setDomain(fit([value]))}
        onTrack={() => 'order'}
      />
      <p className="px-3 pt-1 text-xs text-level3">Drag the order or click the line where it should rest.</p>
      <div className="flex flex-col gap-2.5 px-3 pt-2.5 pb-3">
        <div className="flex items-center gap-2">
          <UnitInput
            label="Price"
            unit={spec.quote}
            value={price}
            aria-invalid={Boolean(priceError ?? legError)}
            onChange={(event) => {
              setPrice(event.target.value.trim())
              widen(typed(event.target.value))
            }}
            className="w-36"
          />
          {!exit && (
            <UnitInput
              label="Size"
              unit={spec.base}
              value={size}
              aria-invalid={Boolean(sizeError)}
              onChange={(event) => setSize(event.target.value.trim())}
              className="flex-1"
            />
          )}
          <Button
            look="action"
            disabled={busy || !order.cancelable}
            onClick={() => run({ kind: 'cancel', order: order.ref })}
            className="ml-auto shrink-0"
          >
            Cancel order
          </Button>
        </div>
        {error ? (
          <span className="flex items-center gap-1 text-xs text-level1">
            <ErrorMark className="size-3 shrink-0" />
            {error}
          </span>
        ) : (
          <span className="text-xs text-level3">
            Was <span className="num text-level1">{shownPrice(spec, was)}</span> ·{' '}
            <span className="num text-level1">
              {shownSize(spec, position ? ordered(order, [position]) : order.size)} {spec.base}
            </span>{' '}
            ·{' '}
            {exit
              ? `${venue} replaces the ${exit.kind === 'tp' ? 'take profit' : 'stop loss'}`
              : `${venue} ${MOVES[account.venue]}`}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <OrderNote error={last.error} outcome={last.outcome} lookup={last.lookup} />
        <Button
          look={order.side === 'buy' ? 'bid' : 'ask'}
          size="tall"
          className="w-full"
          disabled={Boolean(error) || !changed || busy || (exit !== null && position === null)}
          onClick={send}
        >
          {busy ? 'Sending…' : changed && !error ? `Move to ${shownPrice(spec, picked)}` : 'Move order'}
        </Button>
      </div>
    </>
  )
}
