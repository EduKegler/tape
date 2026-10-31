import { useEffect, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useSelector } from '@tanstack/react-store'
import { shallow } from '@tanstack/store'
import { useQuery } from '@tanstack/react-query'
import { formatNotional, formatPx, formatQty, notional, parsePx, parseQty, toDisplayFloat } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import type { Base, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent, buildScale, checkCount, checkPrice, checkSize, checkSkew } from '@tape/trade/intent'
import type { DraftField } from '@tape/trade/intent'
import type { Slice } from '@tape/trade/scale-order'
import { estimateLiquidation } from '@tape/trade/liquidation'
import type { Entry } from '@tape/trade/liquidation'
import type { Bps, Side, Tif, TradeError } from '@tape/trade/types'
import type { MarginReading, TradeSession } from '#/trade/hooks'
import { useMarginReading, useTradeCommands, useTradeSession } from '#/trade/hooks'
import { useFrame } from '#/client/hooks'
import { useUsdcBalance, WalletButton } from '#/wallet/Wallet'
import { NETWORK, TESTNET_SITE, VENUES } from '#/site'
import { EnableTrading } from './EnableTrading'
import { Panel, Segmented } from './Panel'
import { Button, Input } from './primitives'
import { specsQuery } from './queries'
import { TradeNote } from './TradeNote'
import { proposedPrice, slippageBps } from './ticket-store'

const plain = (px: string | undefined) => (px ? px.replaceAll(',', '') : '')
type Kind = 'limit' | 'market' | 'scale'
const FIELD_LABEL: Record<DraftField, string> = {
  price: 'Price',
  size: 'Size',
  tif: 'Time in force',
  takeProfit: 'Take profit',
  stopLoss: 'Stop loss',
  start: 'Start price',
  end: 'End price',
  count: 'Orders',
  skew: 'Size skew',
}
const TIF_LABEL: Record<Tif, string> = {
  gtc: 'Good til canceled',
  ioc: 'Immediate or cancel',
  'post-only': 'Post only',
}

export function Ticket({ venue, base, group }: { venue: VenueId; base: Base; group: string }) {
  const specs = useQuery(specsQuery(venue))
  const spec = specs.data?.get(base)
  const session = useTradeSession(venue)
  const aside = (
    <span className="text-xs text-level3">
      {session.status === 'read-only' ? 'Read only' : NETWORK === 'testnet' ? 'Testnet' : null}
    </span>
  )
  return (
    <Panel title="Order ticket" aside={aside}>
      {spec ? (
        <TicketForm
          key={`${spec.key}:${'ref' in session ? session.ref.owner : ''}`}
          spec={spec}
          group={group}
          session={session}
        />
      ) : (
        <p className="p-3 text-level3">{specs.isError ? 'Market rules unavailable.' : 'Loading market rules…'}</p>
      )}
    </Panel>
  )
}

function TicketForm({ spec, group, session }: { spec: MarketSpec; group: string; session: TradeSession }) {
  const [side, setSide] = useState<Side>('buy')
  const [kind, setKind] = useState<Kind>('limit')
  const [built, setBuilt] = useState<TradeError | null>(null)
  const [protect, setProtect] = useState(false)
  const touch = useFrame(
    { kind: 'book', market: spec.key, group },
    (f) => ({ bid: plain(f?.touch.bid), ask: plain(f?.touch.ask) }),
    shallow,
  )
  const near = side === 'buy' ? touch.bid : touch.ask
  const far = side === 'buy' ? touch.ask : touch.bid
  const [mountedAt] = useState(() => Date.now())
  const proposed = useSelector(proposedPrice, (p) => (p && p.at >= mountedAt ? p : null))
  const slippage = useSelector(slippageBps, (s) => s)
  const ref = session.status === 'ready' || session.status === 'setup' ? session.ref : null
  const caps = session.status === 'ready' || session.status === 'setup' ? session.capabilities : null
  const canSend = session.status === 'ready' || (session.status === 'setup' && session.keyed)
  const { run, last } = useTradeCommands(ref)
  const sending = last.pending || last.lookup?.pending === true
  const margin = useMarginReading(ref, spec.venueSymbol)
  const form = useForm({
    defaultValues: {
      price: '',
      size: '',
      tif: 'gtc' as Tif,
      reduceOnly: false,
      takeProfit: '',
      stopLoss: '',
      start: '',
      end: '',
      count: '5',
      skew: '1',
    },
    onSubmit: ({ value }) => {
      if (!ref || !canSend || sending) return
      const triggers = protect && kind !== 'scale' ? {} : { takeProfit: '', stopLoss: '' }
      const result = buildIntent(
        spec,
        { ...value, ...triggers, side, kind, slippage: slippage as Bps, bid: touch.bid, ask: touch.ask },
        caps ?? { tif: ['gtc', 'ioc', 'post-only'], triggers: false, leverage: false, scaleOrders: 0 },
      )
      if (!result.ok) {
        setBuilt({
          kind: 'invalid-order',
          detail: Object.entries(result.errors)
            .map(([k, v]) => `${FIELD_LABEL[k as DraftField]}: ${v}`)
            .join('; '),
        })
        return
      }
      setBuilt(null)
      run({ kind: 'place', intent: result.intent })
    },
  })

  useEffect(() => {
    if (proposed) form.setFieldValue('price', proposed.price)
  }, [proposed, form])

  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <div className="grid grid-cols-2 gap-1 rounded-sm border border-rule p-0.5">
        {(['buy', 'sell'] as const).map((s) => (
          <Button
            key={s}
            look={s === 'buy' ? 'side-buy' : 'side-sell'}
            aria-pressed={side === s}
            onClick={() => setSide(s)}
          >
            {s}
          </Button>
        ))}
      </div>
      <Segmented
        label="Order type"
        value={kind}
        onChange={(k) => {
          setKind(k)
          if (k === 'scale' && form.getFieldValue('tif') === 'ioc') form.setFieldValue('tif', 'gtc')
        }}
        options={[
          { value: 'limit', label: 'Limit' },
          { value: 'market', label: 'Market' },
          ...(caps?.scaleOrders ? [{ value: 'scale' as const, label: 'Scale' }] : []),
        ]}
      />
      {kind === 'limit' && (
        <form.Field name="price" validators={{ onChange: ({ value }) => checkPrice(spec, value) }}>
          {(field) => (
            <Input
              label={`Price (${spec.quote})`}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={field.handleChange}
              error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
              hint={
                near ? (
                  <Button look="quiet" onClick={() => field.handleChange(near)}>
                    {side === 'buy' ? 'Bid' : 'Ask'} {near}
                  </Button>
                ) : null
              }
            />
          )}
        </form.Field>
      )}
      {kind === 'scale' && (
        <div className="grid grid-cols-2 gap-2">
          {(['start', 'end'] as const).map((name) => (
            <form.Field key={name} name={name} validators={{ onChange: ({ value }) => checkPrice(spec, value) }}>
              {(field) => (
                <Input
                  label={FIELD_LABEL[name]}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
                  hint={
                    near ? (
                      <Button look="quiet" onClick={() => field.handleChange(near)}>
                        {side === 'buy' ? 'Bid' : 'Ask'}
                      </Button>
                    ) : null
                  }
                />
              )}
            </form.Field>
          ))}
          <form.Field name="count" validators={{ onChange: ({ value }) => checkCount(value, caps?.scaleOrders ?? 0) }}>
            {(field) => (
              <Input
                label={FIELD_LABEL.count}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={field.handleChange}
                error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
                hint={<span className="text-level3">Up to {caps?.scaleOrders}</span>}
              />
            )}
          </form.Field>
          <form.Field name="skew" validators={{ onChange: ({ value }) => checkSkew(value) }}>
            {(field) => (
              <Input
                label={FIELD_LABEL.skew}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={field.handleChange}
                error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
                hint={<span className="text-level3">Last over first</span>}
              />
            )}
          </form.Field>
        </div>
      )}
      <form.Field name="size" validators={{ onChange: ({ value }) => checkSize(spec, value) }}>
        {(field) => (
          <Input
            label={`${kind === 'scale' ? 'Total size' : 'Size'} (${spec.base})`}
            name={field.name}
            value={field.state.value}
            onBlur={field.handleBlur}
            onChange={field.handleChange}
            error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
            hint={<span className="text-level3">Step {formatQty(spec.step, spec.scale)}</span>}
          />
        )}
      </form.Field>
      {kind !== 'market' ? (
        <form.Field name="tif">
          {(field) => (
            <label className="flex items-center justify-between text-sm text-level3">
              Time in force
              <select
                name="tif"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value as Tif)}
                className="rounded-sm border border-rule bg-surface px-1.5 py-1 text-sm text-level1"
              >
                {(caps?.tif ?? (['gtc', 'ioc', 'post-only'] as const))
                  .filter((t) => kind !== 'scale' || t !== 'ioc')
                  .map((t) => (
                    <option key={t} value={t}>
                      {TIF_LABEL[t]}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </form.Field>
      ) : (
        <SlippageField />
      )}
      <form.Field name="reduceOnly">
        {(field) => (
          <label className="flex items-center gap-2 text-sm text-level2">
            <input
              type="checkbox"
              name="reduceOnly"
              checked={field.state.value}
              onChange={(e) => field.handleChange(e.target.checked)}
            />
            Reduce only
          </label>
        )}
      </form.Field>
      {caps?.triggers && kind !== 'scale' && (
        <label className="flex items-center gap-2 text-sm text-level2">
          <input type="checkbox" name="protect" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
          Take profit and stop loss
        </label>
      )}
      {caps?.triggers && kind !== 'scale' && protect && (
        <div className="grid grid-cols-2 gap-2">
          {(['takeProfit', 'stopLoss'] as const).map((name) => (
            <form.Field
              key={name}
              name={name}
              validators={{ onChange: ({ value }) => (value ? checkPrice(spec, value) : undefined) }}
            >
              {(field) => (
                <Input
                  label={name === 'takeProfit' ? 'Take profit' : 'Stop loss'}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
                  hint={null}
                />
              )}
            </form.Field>
          ))}
        </div>
      )}
      <form.Subscribe selector={(s) => [s.values, s.canSubmit] as const}>
        {([values, canSubmit]) => {
          const scale = kind === 'scale' ? buildScale(spec, { ...values, side }, caps?.scaleOrders ?? 0) : null
          const legs = scale?.ok ? scale.legs : null
          const px = kind === 'market' ? far : checkPrice(spec, values.price) ? '' : values.price
          const entry = legs ? averageEntry(spec, side, legs) : singleEntry(spec, side, px, values.size)
          const total = entry ? `${formatNotional(entry.notional, spec.scale)} ${spec.quote}` : '—'
          return (
            <>
              <dl className="num grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-level3">Notional</dt>
                <dd className="text-right text-level1">{total}</dd>
                {margin.status !== 'no-estimate' && (
                  <>
                    <dt className="text-level3">Est. liquidation</dt>
                    <dd className="text-right text-level1">{liquidationText(spec, margin, entry)}</dd>
                  </>
                )}
                {NETWORK === 'mainnet' && <MainnetWalletUsdc />}
              </dl>
              {legs && <ScaleLegs spec={spec} legs={legs} />}
              <SubmitArea
                session={session}
                venue={VENUES[spec.venue].label}
                side={side}
                base={spec.base}
                canSubmit={canSubmit && canSend && !sending}
              />
            </>
          )
        }}
      </form.Subscribe>
      {built && <TradeNote error={built} />}
      {last.command?.kind === 'place' && <TradeNote error={last.error} outcome={last.outcome} lookup={last.lookup} />}
    </form>
  )
}

type Preview = Entry & { readonly notional: bigint }

function singleEntry(spec: MarketSpec, side: Side, px: string, size: string): Preview | null {
  if (!px || !size || checkSize(spec, size)) return null
  try {
    return {
      side,
      px: Number(px),
      size: Number(size),
      notional: notional(parsePx(px, spec.scale), parseQty(size, spec.scale)),
    }
  } catch {
    return null
  }
}

function averageEntry(spec: MarketSpec, side: Side, legs: readonly Slice[]): Preview {
  const total = legs.reduce((sum, l) => sum + notional(l.px, l.size), 0n)
  const size = toDisplayFloat(legs.reduce((sum, l) => sum + l.size, 0) as Qty, spec.scale.qty)
  return { side, size, px: Number(total) / 10 ** (spec.scale.px + spec.scale.qty) / size, notional: total }
}

function ScaleLegs({ spec, legs }: { spec: MarketSpec; legs: readonly Slice[] }) {
  return (
    <ol aria-label="Scale orders" className="num flex max-h-40 flex-col gap-0.5 overflow-y-auto text-sm">
      {legs.map((l) => (
        <li key={l.px} className="flex justify-between">
          <span className="text-level3">{formatPx(l.px, spec.scale)}</span>
          <span className="text-level1">{formatQty(l.size, spec.scale)}</span>
        </li>
      ))}
    </ol>
  )
}

function liquidationText(spec: MarketSpec, margin: MarginReading, entry: Entry | null): string {
  if (margin.status !== 'known' || !entry) return '—'
  const liq = estimateLiquidation(margin.state, entry)
  switch (liq.kind) {
    case 'price':
      return `${formatPx(Math.round(liq.px * 10 ** spec.scale.px) as Px, spec.scale)} ${spec.quote}`
    case 'none':
      return 'None'
    case 'insufficient-margin':
      return 'Not enough margin'
    case 'unsupported':
      return liq.reason
  }
}

function SubmitArea({
  session,
  venue,
  side,
  base,
  canSubmit,
}: {
  session: TradeSession
  venue: string
  side: Side
  base: string
  canSubmit: boolean
}) {
  const label = `${side === 'buy' ? 'Buy' : 'Sell'} ${base}`
  const button = (
    <Button look={side === 'buy' ? 'buy' : 'sell'} type="submit" disabled={!canSubmit}>
      {label}
    </Button>
  )
  switch (session.status) {
    case 'read-only':
      return session.cause === 'venue-not-traded' ? (
        <p className="text-xs/snug text-level3">{venue} is read only in Tape. It never signs or sends an order here.</p>
      ) : (
        <SiteReadOnly />
      )
    case 'unavailable':
      return <p className="text-sm text-level3">{session.reason}.</p>
    case 'disconnected':
      return <WalletButton />
    case 'setup':
      return (
        <>
          <EnableTrading session={session} />
          {session.keyed && button}
        </>
      )
    case 'ready':
      return (
        <>
          {button}
          <Button look="quiet" onClick={session.forget} className="self-end">
            Forget trading key on this device
          </Button>
        </>
      )
  }
}

function MainnetWalletUsdc() {
  const balance = useUsdcBalance()
  return (
    <>
      <dt className="text-level3">Wallet USDC</dt>
      <dd className="text-right text-level1">{balance ? `${balance.amount} · ${balance.chain}` : 'Not connected'}</dd>
    </>
  )
}

export function SiteReadOnly() {
  return (
    <p className="text-xs/snug text-level3">
      Mainnet is read only in Tape.{' '}
      {TESTNET_SITE && (
        <>
          Trading runs on{' '}
          <a href={TESTNET_SITE} className="text-level1 underline underline-offset-2">
            testnet
          </a>
          .
        </>
      )}
    </p>
  )
}

function SlippageField() {
  const value = useSelector(slippageBps, (s) => s)
  const options = [10, 50, 100, 300] as const
  return (
    <div className="flex items-center justify-between text-sm text-level3">
      Max slippage
      <Segmented
        label="Max slippage"
        value={String(value)}
        onChange={(v) => slippageBps.setState(() => Number(v))}
        options={options.map((o) => ({ value: String(o), label: `${o / 100}%` }))}
      />
    </div>
  )
}
