import { useEffect, useId, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useSelector } from '@tanstack/react-store'
import { shallow } from '@tanstack/store'
import { useQuery } from '@tanstack/react-query'
import { formatNotional, formatPx, formatQty, notional, parsePx, parseQty } from '@tape/core/fixed'
import type { Px } from '@tape/core/fixed'
import type { Base, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { useFrame } from '#/client/hooks'
import { useMarginState, useTradeCommands, useTradeSession } from '#/trade/hooks'
import type { TradeSession } from '#/trade/hooks'
import { buildIntent, checkPrice, checkSize } from '@tape/trade/intent'
import { estimateLiquidation } from '@tape/trade/liquidation'
import type { Entry, MarginState } from '@tape/trade/liquidation'
import type { Bps, Side, Tif, TradeError } from '@tape/trade/types'
import { useUsdcBalance, WalletButton } from '#/wallet/Wallet'
import { NETWORK, TESTNET_SITE, VENUES } from '#/site'
import { EnableTrading } from './EnableTrading'
import { Panel, Segmented } from './Panel'
import { specsQuery } from './queries'
import { TradeNote } from './TradeNote'
import { proposedPrice, slippageBps } from './ticket-store'

const plain = (px: string | undefined) => (px ? px.replaceAll(',', '') : '')
type Kind = 'limit' | 'market'
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
    <span className="text-[11px] text-level3">
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
  // The exact touch, not the mid or a grouped row: a mid can fall between ticks, and a market order fills on the far side.
  const touch = useFrame(
    { kind: 'book', market: spec.key, group },
    (f) => ({ bid: plain(f?.bid), ask: plain(f?.ask) }),
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
  const margin = useMarginState(ref, spec.venueSymbol)
  const form = useForm({
    defaultValues: { price: '', size: '', tif: 'gtc' as Tif, reduceOnly: false, takeProfit: '', stopLoss: '' },
    onSubmit: ({ value }) => {
      if (!ref || !canSend || last.pending) return
      const triggers = protect && kind === 'limit' ? {} : { takeProfit: '', stopLoss: '' }
      const result = buildIntent(
        spec,
        { ...value, ...triggers, side, kind, slippage: slippage as Bps },
        caps ?? { tif: ['gtc', 'ioc', 'post-only'], triggers: false, leverage: false },
      )
      if (!result.ok) {
        setBuilt({
          kind: 'invalid-order',
          detail: Object.entries(result.errors)
            .map(([k, v]) => `${k}: ${v}`)
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
      <div className="grid grid-cols-2 gap-1 rounded-full border border-rule p-0.5">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => setSide(s)}
            className={`rounded-full py-1 text-[13px] capitalize ${side === s ? (s === 'buy' ? 'bg-bid-wash text-bid' : 'bg-ask-wash text-ask') : 'text-level3'}`}
          >
            {s}
          </button>
        ))}
      </div>
      <Segmented
        label="Order type"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'limit', label: 'Limit' },
          { value: 'market', label: 'Market' },
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
                  <button
                    type="button"
                    className="text-level3 hover:text-level1"
                    onClick={() => field.handleChange(near)}
                  >
                    {side === 'buy' ? 'Bid' : 'Ask'} {near}
                  </button>
                ) : null
              }
            />
          )}
        </form.Field>
      )}
      <form.Field name="size" validators={{ onChange: ({ value }) => checkSize(spec, value) }}>
        {(field) => (
          <Input
            label={`Size (${spec.base})`}
            name={field.name}
            value={field.state.value}
            onBlur={field.handleBlur}
            onChange={field.handleChange}
            error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
            hint={<span className="text-level3">Step {formatQty(spec.step, spec.scale)}</span>}
          />
        )}
      </form.Field>
      {kind === 'limit' ? (
        <form.Field name="tif">
          {(field) => (
            <label className="flex items-center justify-between text-[12px] text-level3">
              Time in force
              <select
                name="tif"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value as Tif)}
                className="rounded-sm border border-rule bg-surface px-1.5 py-1 text-[12px] text-level1"
              >
                {(caps?.tif ?? (['gtc', 'ioc', 'post-only'] as const)).map((t) => (
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
          <label className="flex items-center gap-2 text-[12px] text-level2">
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
      {caps?.triggers && kind === 'limit' && (
        <label className="flex items-center gap-2 text-[12px] text-level2">
          <input type="checkbox" name="protect" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
          Take profit and stop loss
        </label>
      )}
      {caps?.triggers && kind === 'limit' && protect && (
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
      <form.Subscribe selector={(s) => [s.values.price, s.values.size, s.canSubmit] as const}>
        {([price, size, canSubmit]) => {
          const px = kind === 'market' ? far : price
          const valid = Boolean(px && size && !checkSize(spec, size) && (kind === 'market' || !checkPrice(spec, px)))
          let total = '—'
          if (valid) {
            try {
              total = `${formatNotional(notional(parsePx(px, spec.scale), parseQty(size, spec.scale)), spec.scale)} ${spec.quote}`
            } catch {
              total = '—'
            }
          }
          return (
            <>
              <dl className="num grid grid-cols-2 gap-y-1 text-[12px]">
                <dt className="text-level3">Notional</dt>
                <dd className="text-right text-level1">{total}</dd>
                {margin !== null && (
                  <>
                    <dt className="text-level3">Est. liquidation</dt>
                    <dd className="text-right text-level1">
                      {liquidationText(spec, margin, valid ? { side, size: Number(size), px: Number(px) } : null)}
                    </dd>
                  </>
                )}
                {NETWORK === 'mainnet' && <WalletUsdc />}
              </dl>
              <SubmitArea
                session={session}
                venue={VENUES[spec.venue].label}
                side={side}
                base={spec.base}
                canSubmit={canSubmit && canSend && !last.pending}
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

function liquidationText(spec: MarketSpec, margin: MarginState | undefined, entry: Entry | null): string {
  if (!margin || !entry) return '—'
  const liq = estimateLiquidation(margin, entry)
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
    <button
      type="submit"
      disabled={!canSubmit}
      className={`rounded-full py-2 text-[13px] disabled:opacity-40 ${side === 'buy' ? 'bg-bid text-surface' : 'bg-ask text-surface'}`}
    >
      {label}
    </button>
  )
  switch (session.status) {
    case 'read-only':
      return session.scope === 'venue' ? (
        <p className="text-[11px] leading-snug text-level3">
          {venue} is read only in Tape. It never signs or sends an order here.
        </p>
      ) : (
        <SiteReadOnly />
      )
    case 'unavailable':
      return <p className="text-[12px] text-level3">{session.reason}.</p>
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
          <button type="button" onClick={session.forget} className="self-end text-[11px] text-level3 hover:text-level1">
            Forget trading key on this device
          </button>
        </>
      )
  }
}

/** A mainnet balance, so a testnet build never mounts it and never calls a mainnet RPC. */
function WalletUsdc() {
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
    <p className="text-[11px] leading-snug text-level3">
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
    <div className="flex items-center justify-between text-[12px] text-level3">
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

function Input(props: {
  label: string
  name: string
  value: string
  error: string | undefined
  hint: React.ReactNode
  onChange: (v: string) => void
  onBlur: () => void
}) {
  const id = useId()
  // The hint can be a button, so it sits beside the label and not inside it.
  return (
    <div className="flex flex-col gap-1 text-[12px]">
      <div className="flex justify-between text-level3">
        <label htmlFor={id}>{props.label}</label>
        {props.hint}
      </div>
      <input
        id={id}
        name={props.name}
        inputMode="decimal"
        autoComplete="off"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.trim())}
        onBlur={props.onBlur}
        aria-invalid={Boolean(props.error)}
        aria-describedby={props.error ? `${id}-error` : undefined}
        className="num rounded-sm border border-rule bg-surface px-2 py-1.5 text-[13px] text-level1 outline-none focus:border-ink aria-invalid:border-ask"
      />
      {props.error && (
        <span id={`${id}-error`} className="text-ask">
          {props.error}
        </span>
      )}
    </div>
  )
}
