import { useEffect, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useSelector } from '@tanstack/react-store'
import { useQuery } from '@tanstack/react-query'
import { DecimalError, formatNotional, formatPx, formatQty, notional, parsePx, parseQty } from '#/core/fixed'
import type { Base, VenueId } from '#/core/ids'
import type { MarketSpec } from '#/core/market'
import { effectiveTick } from '#/core/market'
import { useFrame } from '#/client/hooks'
import { useUsdcBalance } from '#/wallet/Wallet'
import { VENUES } from '#/venues/index'
import { Panel, Segmented } from './Panel'
import { specsQuery } from './queries'
import { proposedPrice } from './ticket-store'

type Side = 'buy' | 'sell'
type Kind = 'limit' | 'market'

/** Validation is exact: a price must sit on the tick and a size on the step, checked in integers. */
function checkPrice(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a price'
  try {
    const px = parsePx(value, spec.scale)
    if (px <= 0) return 'Price must be above zero'
    const tick = effectiveTick(spec, px)
    if (px % tick !== 0) return `Price must be a multiple of ${formatPx(tick, spec.scale)}`
  } catch (e) {
    if (e instanceof DecimalError) return e.reason === 'precision' ? `At most ${spec.scale.px} decimals` : 'Not a number'
    throw e
  }
  return undefined
}

function checkSize(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a size'
  try {
    const qty = parseQty(value, spec.scale)
    if (qty < spec.step) return `Minimum is ${formatQty(spec.step, spec.scale)}`
    if (qty % spec.step !== 0) return `Size must be a multiple of ${formatQty(spec.step, spec.scale)}`
  } catch (e) {
    if (e instanceof DecimalError) return e.reason === 'precision' ? `At most ${spec.scale.qty} decimals` : 'Not a number'
    throw e
  }
  return undefined
}

export function Ticket({ venue, base, group }: { venue: VenueId; base: Base; group: string }) {
  const specs = useQuery(specsQuery(venue))
  const spec = specs.data?.get(base)
  return (
    <Panel title="Order ticket" aside={<span className="text-[11px] text-level3">Preview only</span>}>
      {spec ? <TicketForm key={spec.key} spec={spec} group={group} /> : <p className="p-3 text-level3">{specs.isError ? 'Market rules unavailable.' : 'Loading market rules…'}</p>}
    </Panel>
  )
}

function TicketForm({ spec, group }: { spec: MarketSpec; group: string }) {
  const [side, setSide] = useState<Side>('buy')
  const [kind, setKind] = useState<Kind>('limit')
  const [preview, setPreview] = useState<string | null>(null)
  const mid = useFrame({ kind: 'book', market: spec.key, group }, (f) => f?.mid.replaceAll(',', '') ?? '')
  const proposed = useSelector(proposedPrice)
  const balance = useUsdcBalance()
  const form = useForm({
    defaultValues: { price: '', size: '' },
    onSubmit: ({ value }) => {
      const px = kind === 'market' ? mid : value.price
      setPreview(`${side === 'buy' ? 'Buy' : 'Sell'} ${value.size} ${spec.base} ${kind === 'market' ? 'at market' : `at ${px}`} on ${VENUES[spec.venue].label}. Nothing was sent.`)
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
      <Segmented label="Order type" value={kind} onChange={setKind} options={[{ value: 'limit', label: 'Limit' }, { value: 'market', label: 'Market' }]} />
      {kind === 'limit' && (
        <form.Field name="price" validators={{ onChange: ({ value }) => checkPrice(spec, value) }}>
          {(field) => (
            <Input label={`Price (${spec.quote})`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={field.handleChange}
              error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
              hint={mid ? <button type="button" className="text-level3 hover:text-level1" onClick={() => field.handleChange(mid)}>Mid {mid}</button> : null} />
          )}
        </form.Field>
      )}
      <form.Field name="size" validators={{ onChange: ({ value }) => checkSize(spec, value) }}>
        {(field) => (
          <Input label={`Size (${spec.base})`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={field.handleChange}
            error={field.state.meta.isTouched ? field.state.meta.errors[0] : undefined}
            hint={<span className="text-level3">Step {formatQty(spec.step, spec.scale)}</span>} />
        )}
      </form.Field>
      <form.Subscribe selector={(s) => [s.values.price, s.values.size, s.canSubmit] as const}>
        {([price, size, canSubmit]) => {
          const px = kind === 'market' ? mid : price
          let total = '—'
          if (px && size && !checkSize(spec, size) && (kind === 'market' || !checkPrice(spec, px))) {
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
                <dt className="text-level3">Wallet USDC</dt>
                <dd className="text-right text-level1">{balance ? `${balance.amount} · ${balance.chain}` : 'Not connected'}</dd>
              </dl>
              <button
                type="submit"
                disabled={!canSubmit}
                className={`rounded-full py-2 text-[13px] disabled:opacity-40 ${side === 'buy' ? 'bg-bid text-surface' : 'bg-ask text-surface'}`}
              >
                Preview {side} {spec.base}
              </button>
            </>
          )
        }}
      </form.Subscribe>
      {preview && <p className="rounded border border-rule p-2 text-[12px] text-level2" role="status">{preview}</p>}
      <p className="text-[11px] leading-snug text-level3">Tape is read-only. It never signs, sends or stores an order.</p>
    </form>
  )
}

function Input(props: { label: string; name: string; value: string; error: string | undefined; hint: React.ReactNode; onChange: (v: string) => void; onBlur: () => void }) {
  return (
    <label className="flex flex-col gap-1 text-[12px]">
      <span className="flex justify-between text-level3">
        {props.label}
        {props.hint}
      </span>
      <input
        name={props.name}
        inputMode="decimal"
        autoComplete="off"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.trim())}
        onBlur={props.onBlur}
        aria-invalid={Boolean(props.error)}
        className="num rounded border border-rule bg-surface px-2 py-1.5 text-[13px] text-level1 outline-none focus:border-ink aria-invalid:border-ask"
      />
      {props.error && <span className="text-ask">{props.error}</span>}
    </label>
  )
}

