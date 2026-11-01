import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useForm } from '@tanstack/react-form'
import { useSelector } from '@tanstack/react-store'
import { shallow } from '@tanstack/store'
import { useQuery } from '@tanstack/react-query'
import {
  formatNotional,
  formatPx,
  formatQty,
  notional,
  parsePx,
  parseQty,
  toDisplayFloat,
  toPx,
  toQty,
} from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import {
  buildIntent,
  buildScale,
  checkCount,
  checkPrice,
  checkRetracement,
  checkShare,
  checkSize,
  checkSkew,
  isDraftField,
  splitSize,
  takeProfitField,
} from '@tape/trade/intent'
import type { DraftField, TakeProfitDraft } from '@tape/trade/intent'
import { apportion } from '@tape/trade/scale-order'
import type { Slice } from '@tape/trade/scale-order'
import { estimateLiquidation } from '@tape/trade/liquidation'
import type { Entry } from '@tape/trade/liquidation'
import { isTif, toBps } from '@tape/trade/types'
import type { Capabilities, Side, Tif, TradeError } from '@tape/trade/types'
import type { MarginReading, TradeSession } from '#/trade/hooks'
import { useMarginReading, useTradeCommands, useTradeSession } from '#/trade/hooks'
import { useFrame, useFrameEffect } from '#/client/hooks'
import { useUsdcBalance, WalletButton } from '#/wallet/Wallet'
import { NETWORK, TESTNET_SITE, VENUES } from '#/site'
import { ErrorMark } from './ErrorMark'
import { EnableTrading } from './EnableTrading'
import { groupThousands } from './format'
import { Panel, Segmented } from './Panel'
import { STALE_AFTER_MS } from './panel-state'
import { TopicStatus } from './PanelStatus'
import { Button, Checkbox, Input, Select, TextLink } from './primitives'
import { marketQuery } from './queries'
import { OrderNote, TradeNote } from './TradeNote'
import { proposedPrice, SLIPPAGE_STEPS, slippageBps } from './ticket-store'

const plain = (px: string | undefined) => (px ? px.replaceAll(',', '') : '')
type Kind = 'limit' | 'market' | 'scale' | 'trailing'
const DEFAULT_VALUES = {
  price: '',
  size: '',
  tif: 'gtc' as Tif,
  reduceOnly: false,
  takeProfits: [{ price: '', share: '100' }] as TakeProfitDraft[],
  stopLoss: '',
  start: '',
  end: '',
  count: '5',
  skew: '1',
  retracement: '',
  retracementUnit: 'pct' as 'pct' | 'px',
  activation: '',
}
type TicketValues = typeof DEFAULT_VALUES
const NO_CAPS: Capabilities = {
  tif: ['gtc', 'ioc', 'post-only'],
  triggers: null,
  leverage: false,
  scaleOrders: 0,
  trailingStop: false,
}
const NO_ERRORS: Partial<Record<DraftField, string>> = {}
type FieldShape = {
  readonly name: string
  readonly state: { readonly meta: { readonly isTouched: boolean; readonly errors: readonly (string | undefined)[] } }
}
const draftField = (name: string): DraftField | null => {
  const row = /^takeProfits\[(\d+)\]\.price$/.exec(name)
  if (row) return takeProfitField(Number(row[1]))
  return hasLabel(name) && name !== 'takeProfits' ? name : null
}
const FIELD_LABEL = {
  price: 'Price',
  size: 'Size',
  tif: 'Time in force',
  takeProfits: 'Take profits',
  stopLoss: 'Stop loss',
  start: 'Start price',
  end: 'End price',
  count: 'Orders',
  skew: 'Size skew',
  retracement: 'Retracement',
  activation: 'Activation price',
} as const
const hasLabel = (name: string): name is keyof typeof FIELD_LABEL => Object.hasOwn(FIELD_LABEL, name)
const fieldLabel = (field: DraftField, takeProfits: number) =>
  hasLabel(field) ? FIELD_LABEL[field] : takeProfitLabel(Number(field.slice(10)) - 1, takeProfits)
const takeProfitLabel = (index: number, count: number) => (count > 1 ? `Take profit ${index + 1}` : 'Take profit')
const evenShares = (count: number) =>
  apportion(
    100,
    Array.from({ length: count }, () => 1),
  ).map(String)
const takesExits = (kind: Kind) => kind === 'limit' || kind === 'market'
const TIF_LABEL: Record<Tif, string> = {
  gtc: 'Good til canceled',
  ioc: 'Immediate or cancel',
  'post-only': 'Post only',
}

export function Ticket({ venue, base, group }: { venue: VenueId; base: Base; group: string }) {
  const specs = useQuery(marketQuery(venue, base))
  const spec = specs.data ?? undefined
  const session = useTradeSession(venue)
  const note = (
    <span className="ml-auto flex min-w-0 items-baseline gap-2">
      <TopicStatus
        topic={{ kind: 'book', market: marketKey(venue, base), group }}
        ageLimit
        error={specs.isError ? 'Could not load market rules.' : null}
        onRetry={() => void specs.refetch()}
      />
      <span className="shrink-0 text-xs text-level3">
        {session.status === 'read-only' ? 'Read only' : NETWORK === 'testnet' ? 'Testnet' : null}
      </span>
    </span>
  )
  return (
    <Panel title="Order ticket" tone="ticket" bare>
      {spec ? (
        <TicketForm
          key={`${spec.key}:${'ref' in session ? session.ref.owner : ''}`}
          spec={spec}
          group={group}
          session={session}
          note={note}
        />
      ) : (
        <div className="flex flex-col gap-2 p-3">
          {note}
          <p className="text-level3">{specs.isError ? 'Market rules unavailable.' : 'Loading market rules…'}</p>
        </div>
      )}
    </Panel>
  )
}

function TicketForm({
  spec,
  group,
  session,
  note,
}: {
  spec: MarketSpec
  group: string
  session: TradeSession
  note: ReactNode
}) {
  const [side, setSide] = useState<Side>('buy')
  const [kind, setKind] = useState<Kind>('limit')
  const [built, setBuilt] = useState<TradeError | null>(null)
  const [protect, setProtect] = useState(false)
  const touch = useFrame(
    { kind: 'book', market: spec.key, group },
    (frame) => ({ bid: plain(frame?.touch.bid), ask: plain(frame?.touch.ask) }),
    shallow,
  )
  const near = side === 'buy' ? touch.bid : touch.ask
  const far = side === 'buy' ? touch.ask : touch.bid
  const [mountedAt] = useState(() => Date.now())
  const proposed = useSelector(proposedPrice, (proposal) => (proposal && proposal.at >= mountedAt ? proposal : null))
  const slippage = useSelector(slippageBps, (state) => state)
  const ref = session.status === 'ready' || session.status === 'setup' ? session.ref : null
  const caps = session.status === 'ready' || session.status === 'setup' ? session.capabilities : null
  const canSend = session.status === 'ready' || (session.status === 'setup' && session.keyed)
  const { run, last } = useTradeCommands(ref)
  const [sent, setSent] = useState<string | null>(null)
  const draftOf = (values: object) => JSON.stringify([side, kind, protect, values])
  const margin = useMarginReading(ref, spec.venueSymbol)
  const build = (value: TicketValues) => {
    const exits = protect && takesExits(kind)
    const rows = value.takeProfits
    return buildIntent(
      spec,
      {
        ...value,
        takeProfits: !exits || (rows.length === 1 && !rows[0]?.price) ? [] : rows,
        stopLoss: exits ? value.stopLoss : '',
        side,
        kind,
        slippage,
        bid: touch.bid,
        ask: touch.ask,
      },
      caps ?? NO_CAPS,
    )
  }
  const form = useForm({
    defaultValues: DEFAULT_VALUES,
    onSubmit: ({ value }) => {
      if (!ref || !canSend || HOLDS.has(phaseOf(last, sent, draftOf(value)))) return
      const result = build(value)
      if (!result.ok) {
        setBuilt({
          kind: 'invalid-order',
          detail: Object.entries(result.errors)
            .map(
              ([field, message]) =>
                `${isDraftField(field) ? fieldLabel(field, value.takeProfits.length) : field}: ${message}`,
            )
            .join('; '),
        })
        return
      }
      setBuilt(null)
      setSent(draftOf(value))
      run({ kind: 'place', intent: result.intent })
    },
  })

  const drafted = useSelector(
    form.store,
    (state): Partial<Record<DraftField, string>> => {
      const result = build(state.values)
      return result.ok ? NO_ERRORS : result.errors
    },
    { compare: shallow },
  )
  const fieldError = (field: FieldShape) => {
    if (!field.state.meta.isTouched) return undefined
    const own = field.state.meta.errors[0]
    if (own) return own
    const name = draftField(field.name)
    return name ? drafted[name] : undefined
  }

  const book = useRef<{ readonly live: boolean; readonly at: number | null }>({ live: false, at: null })
  useFrameEffect({ kind: 'book', market: spec.key, group }, (frame) => {
    book.current = { live: frame.status === 'live', at: frame.liveAt }
  })
  const [priceNote, setPriceNote] = useState<string | null>(null)
  useEffect(() => {
    if (!proposed) return
    form.setFieldValue('price', proposed.price)
    setPriceNote(oldBookNote(book.current, proposed.at))
  }, [proposed, form])

  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <fieldset disabled={last.pending} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-inset p-1">
          {(['buy', 'sell'] as const).map((choice) => (
            <Button
              key={choice}
              look={choice === 'buy' ? 'side-buy' : 'side-sell'}
              aria-pressed={side === choice}
              onClick={() => setSide(choice)}
            >
              {choice === 'buy' ? 'Buy / Long' : 'Sell / Short'}
            </Button>
          ))}
        </div>
        <div className="-mx-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-rule px-3 pb-2">
          <Segmented
            label="Order type"
            value={kind}
            onChange={(nextKind) => {
              if (nextKind === 'trailing' || kind === 'trailing')
                form.setFieldValue('reduceOnly', nextKind === 'trailing')
              setKind(nextKind)
              if (nextKind === 'scale' && form.getFieldValue('tif') === 'ioc') form.setFieldValue('tif', 'gtc')
            }}
            options={[
              { value: 'limit', label: 'Limit' },
              { value: 'market', label: 'Market' },
              ...(caps?.scaleOrders ? [{ value: 'scale' as const, label: 'Scale' }] : []),
              ...(caps?.trailingStop ? [{ value: 'trailing' as const, label: 'Trailing stop' }] : []),
            ]}
          />
          {note}
        </div>
        {kind === 'trailing' && (
          <div className="flex flex-col gap-2">
            <form.Field name="retracementUnit">
              {(unit) => (
                <>
                  <form.Field
                    name="retracement"
                    validators={{
                      onChangeListenTo: ['retracementUnit'],
                      onChange: ({ value }) => checkRetracement(spec, form.getFieldValue('retracementUnit'), value),
                    }}
                  >
                    {(field) => (
                      <Input
                        label={`${FIELD_LABEL.retracement} (${unit.state.value === 'pct' ? '%' : spec.quote})`}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={field.handleChange}
                        error={fieldError(field)}
                        hint={<span className="text-level3">From the best price</span>}
                      />
                    )}
                  </form.Field>
                  <Segmented
                    label="Retracement in"
                    value={unit.state.value}
                    onChange={unit.handleChange}
                    options={[
                      { value: 'pct', label: 'Percent' },
                      { value: 'px', label: spec.quote },
                    ]}
                  />
                </>
              )}
            </form.Field>
            <form.Field
              name="activation"
              validators={{ onChange: ({ value }) => (value ? checkPrice(spec, value) : undefined) }}
            >
              {(field) => (
                <Input
                  label={`${FIELD_LABEL.activation} (${spec.quote})`}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  error={fieldError(field)}
                  hint={<span className="text-level3">Empty to trail at once</span>}
                />
              )}
            </form.Field>
          </div>
        )}
        {kind === 'limit' && (
          <form.Field name="price" validators={{ onChange: ({ value }) => checkPrice(spec, value) }}>
            {(field) => (
              <Input
                label={`Price (${spec.quote})`}
                unit={spec.quote}
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(value) => {
                  setPriceNote(null)
                  field.handleChange(value)
                }}
                error={fieldError(field)}
                warning={priceNote}
                messageLine
                hint={
                  near ? (
                    <Button
                      look="quiet"
                      onClick={() => {
                        setPriceNote(null)
                        field.handleChange(near)
                      }}
                    >
                      {side === 'buy' ? 'Bid' : 'Ask'} <span className="num">{groupThousands(near)}</span>
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
                    error={fieldError(field)}
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
            <form.Field
              name="count"
              validators={{ onChange: ({ value }) => checkCount(value, caps?.scaleOrders ?? 0) }}
            >
              {(field) => (
                <Input
                  label={FIELD_LABEL.count}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  error={fieldError(field)}
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
                  error={fieldError(field)}
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
              unit={spec.base}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={field.handleChange}
              error={fieldError(field)}
              hint={
                <span className="text-level3">
                  Step <span className="num">{formatQty(spec.step, spec.scale)}</span>
                </span>
              }
            />
          )}
        </form.Field>
        {kind === 'trailing' ? null : kind !== 'market' ? (
          <form.Field name="tif">
            {(field) => (
              <label className="flex flex-col gap-1 text-xs text-level3">
                Time in force
                <Select
                  size="field"
                  name="tif"
                  value={field.state.value}
                  onChange={(value) => {
                    if (isTif(value)) field.handleChange(value)
                  }}
                >
                  {(caps?.tif ?? (['gtc', 'ioc', 'post-only'] as const))
                    .filter((tif) => kind !== 'scale' || tif !== 'ioc')
                    .map((tif) => (
                      <option key={tif} value={tif}>
                        {TIF_LABEL[tif]}
                      </option>
                    ))}
                </Select>
              </label>
            )}
          </form.Field>
        ) : (
          <SlippageField />
        )}
        <form.Field name="reduceOnly">
          {(field) => (
            <Checkbox
              label="Reduce only"
              name="reduceOnly"
              checked={field.state.value}
              onChange={(checked) => field.handleChange(checked)}
            />
          )}
        </form.Field>
        {caps?.triggers && takesExits(kind) && (
          <Checkbox label="Take profit and stop loss" name="protect" checked={protect} onChange={setProtect} />
        )}
        {caps?.triggers && takesExits(kind) && protect && (
          <div className="flex flex-col gap-2">
            <form.Field name="takeProfits" mode="array">
              {(rows) => {
                const count = rows.state.value.length
                const reshare = (next: number) =>
                  evenShares(next).forEach((share, index) => form.setFieldValue(`takeProfits[${index}].share`, share))
                return (
                  <>
                    {rows.state.value.map((_, index) => (
                      // eslint-disable-next-line @eslint-react/no-array-index-key -- TanStack Form names array fields by index, so a row is its index
                      <div key={index} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <form.Field
                            name={`takeProfits[${index}].price`}
                            validators={{ onChange: ({ value }) => (value ? checkPrice(spec, value) : undefined) }}
                          >
                            {(field) => (
                              <Input
                                label={takeProfitLabel(index, count)}
                                name={field.name}
                                value={field.state.value}
                                onBlur={field.handleBlur}
                                onChange={field.handleChange}
                                error={fieldError(field)}
                                hint={null}
                              />
                            )}
                          </form.Field>
                        </div>
                        {count > 1 && (
                          <div className="w-20 shrink-0">
                            <form.Field
                              name={`takeProfits[${index}].share`}
                              validators={{ onChange: ({ value }) => checkShare(value) }}
                            >
                              {(field) => (
                                <Input
                                  label={`Size ${index + 1} (%)`}
                                  name={field.name}
                                  value={field.state.value}
                                  onBlur={field.handleBlur}
                                  onChange={field.handleChange}
                                  error={fieldError(field)}
                                  hint={null}
                                />
                              )}
                            </form.Field>
                          </div>
                        )}
                        {count > 1 && (
                          <Button
                            look="quiet"
                            className="h-9 shrink-0"
                            aria-label={`Remove take profit ${index + 1}`}
                            onClick={() => {
                              rows.removeValue(index)
                              reshare(count - 1)
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    ))}
                    <form.Subscribe selector={(state) => state.values.stopLoss !== ''}>
                      {(withStop) =>
                        count + (withStop ? 1 : 0) < (caps.triggers?.orders ?? 0) && (
                          <Button
                            look="quiet"
                            className="self-start"
                            onClick={() => {
                              rows.pushValue({ price: '', share: '' })
                              reshare(count + 1)
                            }}
                          >
                            Add take profit
                          </Button>
                        )
                      }
                    </form.Subscribe>
                  </>
                )
              }}
            </form.Field>
            <form.Field
              name="stopLoss"
              validators={{ onChange: ({ value }) => (value ? checkPrice(spec, value) : undefined) }}
            >
              {(field) => (
                <Input
                  label="Stop loss"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={field.handleChange}
                  error={fieldError(field)}
                  hint={null}
                />
              )}
            </form.Field>
          </div>
        )}
        <form.Subscribe selector={(state) => state.values}>
          {(values) => {
            const legs = scaleLegs(spec, kind, side, values, caps?.scaleOrders ?? 0)
            return (
              <>
                {legs && <ScaleLegs spec={spec} legs={legs} />}
                {protect && takesExits(kind) && values.takeProfits.length > 1 && (
                  <TakeProfitSplit spec={spec} size={values.size} rows={values.takeProfits} />
                )}
              </>
            )
          }}
        </form.Subscribe>
      </fieldset>
      <div className="flex shrink-0 flex-col gap-2 p-3">
        <form.Subscribe selector={(state) => [state.values, state.canSubmit, invalidFields(state.fieldMeta)] as const}>
          {([values, canSubmit, invalid]) => {
            const legs = scaleLegs(spec, kind, side, values, caps?.scaleOrders ?? 0)
            const px =
              kind === 'market' || kind === 'trailing' ? far : checkPrice(spec, values.price) ? '' : values.price
            const entry = legs ? averageEntry(spec, side, legs) : singleEntry(spec, side, px, values.size)
            const total = entry ? formatNotional(entry.notional, spec.scale) : null
            return (
              <>
                <dl className="grid grid-cols-2 items-baseline gap-y-1.5 text-sm">
                  <dt className="text-level3">Notional</dt>
                  <dd className="text-right font-medium text-level1">
                    {total ? (
                      <>
                        <span className="num">{total}</span> {spec.quote}
                      </>
                    ) : (
                      '—'
                    )}
                  </dd>
                  {margin.status !== 'no-estimate' && (
                    <>
                      <dt className="text-level3">Est. liquidation</dt>
                      <dd className="text-right text-level1">{liquidationText(spec, margin, entry)}</dd>
                    </>
                  )}
                  {NETWORK === 'mainnet' && <MainnetWalletUsdc />}
                </dl>
                {built && <TradeNote error={built} />}
                {last.command?.kind === 'place' && (
                  <OrderNote error={last.error} outcome={last.outcome} lookup={last.lookup} />
                )}
                <SubmitArea
                  session={session}
                  venue={VENUES[spec.venue].label}
                  side={side}
                  base={spec.base}
                  phase={phaseOf(last, sent, draftOf(values))}
                  canSubmit={canSubmit && canSend}
                  fix={invalid ? fixText(invalid, values.takeProfits.length) : null}
                />
              </>
            )
          }}
        </form.Subscribe>
      </div>
    </form>
  )
}

function oldBookNote(book: { readonly live: boolean; readonly at: number | null }, now: number): string | null {
  if (book.at === null || (book.live && now - book.at <= STALE_AFTER_MS)) return null
  const seconds = Math.max(0, Math.floor((now - book.at) / 1000))
  const age = seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
  return `Book ${age} old. Check the market.`
}

type Preview = Entry & { readonly notional: bigint }

function scaleLegs(
  spec: MarketSpec,
  kind: Kind,
  side: Side,
  values: Omit<Parameters<typeof buildScale>[1], 'side'>,
  most: number,
): readonly Slice[] | null {
  if (kind !== 'scale') return null
  const scale = buildScale(spec, { ...values, side }, most)
  return scale.ok ? scale.legs : null
}

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
  const total = legs.reduce((sum, leg) => sum + notional(leg.px, leg.size), 0n)
  const size = toDisplayFloat(toQty(legs.reduce((sum, leg) => sum + leg.size, 0)), spec.scale.qty)
  return { side, size, px: Number(total) / 10 ** (spec.scale.px + spec.scale.qty) / size, notional: total }
}

function ScaleLegs({ spec, legs }: { spec: MarketSpec; legs: readonly Slice[] }) {
  return (
    <ol aria-label="Scale orders" className="num flex max-h-40 flex-col gap-0.5 overflow-y-auto text-sm">
      {legs.map((leg) => (
        <li key={leg.px} className="flex justify-between">
          <span className="text-level3">{formatPx(leg.px, spec.scale)}</span>
          <span className="text-level1">{formatQty(leg.size, spec.scale)}</span>
        </li>
      ))}
    </ol>
  )
}

function TakeProfitSplit({ spec, size, rows }: { spec: MarketSpec; size: string; rows: readonly TakeProfitDraft[] }) {
  if (checkSize(spec, size) || rows.some((row) => checkShare(row.share))) return null
  const shares = rows.map((row) => Number(row.share))
  const total = shares.reduce((sum, share) => sum + share, 0)
  if (total !== 100)
    return (
      <p className="flex gap-1.5 text-sm text-level1">
        <ErrorMark />
        Sizes add up to {total}%, not 100%
      </p>
    )
  const sizes = splitSize(spec, parseQty(size, spec.scale), shares)
  return (
    <ol aria-label="Take profit sizes" className="flex flex-col gap-0.5 text-sm">
      {rows.map((row, index) => (
        // eslint-disable-next-line @eslint-react/no-array-index-key -- TanStack Form names array fields by index, so a row is its index
        <li key={index} className="flex justify-between">
          <span className={row.price ? 'num text-level3' : 'text-level3'}>
            {row.price || `Take profit ${index + 1}`}
          </span>
          <span className="num text-level1">{formatQty(sizes[index]!, spec.scale)}</span>
        </li>
      ))}
    </ol>
  )
}

function liquidationText(spec: MarketSpec, margin: MarginReading, entry: Entry | null): ReactNode {
  if (margin.status !== 'known' || !entry) return '—'
  const liq = estimateLiquidation(margin.state, entry)
  switch (liq.kind) {
    case 'price':
      return (
        <span className="num">
          {formatPx(toPx(Math.round(liq.px * 10 ** spec.scale.px)), spec.scale)} {spec.quote}
        </span>
      )
    case 'none':
      return 'None'
    case 'insufficient-margin':
      return 'Not enough margin'
    case 'unsupported':
      return liq.reason
  }
}

function invalidFields(meta: Record<string, { readonly errors?: readonly unknown[] } | undefined>): string | null {
  const names = Object.entries(meta)
    .filter(([, field]) => field?.errors?.some(Boolean))
    .map(([name]) => name)
  return names.length ? names.join(' ') : null
}

function fixText(invalid: string, takeProfits: number): string {
  const labels = invalid.split(' ').map((name) => {
    const row = /^takeProfits\[(\d+)\]\.(price|share)$/.exec(name)
    if (row) return row[2] === 'price' ? takeProfitLabel(Number(row[1]), takeProfits) : `Size ${Number(row[1]) + 1} (%)`
    return hasLabel(name) ? FIELD_LABEL[name] : name
  })
  return `Fix ${labels.join(' and ').toLowerCase()} to send.`
}

type Phase = 'idle' | 'sending' | 'checking' | 'found' | 'resend'
const HOLDS: ReadonlySet<Phase> = new Set(['sending', 'checking', 'found'])
const PHASE_LABEL: Partial<Record<Phase, string>> = {
  sending: 'Sending…',
  checking: 'Checking the venue…',
  found: 'The venue has this order',
}

function phaseOf(last: ReturnType<typeof useTradeCommands>['last'], sent: string | null, draft: string): Phase {
  if (last.pending) return 'sending'
  if (last.command?.kind !== 'place' || last.error?.kind !== 'unknown-outcome') return 'idle'
  if (last.lookup?.pending) return 'checking'
  if (sent !== draft) return 'idle'
  return last.lookup?.result?.kind === 'found' ? 'found' : 'resend'
}

function SubmitArea({
  session,
  venue,
  side,
  base,
  phase,
  canSubmit,
  fix,
}: {
  session: TradeSession
  venue: string
  side: Side
  base: string
  phase: Phase
  canSubmit: boolean
  fix: string | null
}) {
  const fixId = useId()
  const label = `${side === 'buy' ? 'Buy' : 'Sell'} ${base}`
  const why = fix && !canSubmit ? fixId : undefined
  const button = (
    <>
      {why && (
        <p id={fixId} className="text-sm text-level2">
          {fix}
        </p>
      )}
      {phase === 'resend' ? (
        <Button look="secondary" size="lg" type="submit" disabled={!canSubmit} aria-describedby={why}>
          Send again: {label}
        </Button>
      ) : (
        <Button
          look={side === 'buy' ? 'buy' : 'sell'}
          type="submit"
          disabled={!canSubmit || HOLDS.has(phase)}
          aria-describedby={why}
        >
          {PHASE_LABEL[phase] ?? label}
        </Button>
      )}
    </>
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
      return button
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
          Trading runs on <TextLink href={TESTNET_SITE}>testnet</TextLink>.
        </>
      )}
    </p>
  )
}

function SlippageField() {
  const value = useSelector(slippageBps, (state) => state)
  return (
    <div className="flex items-center justify-between text-sm text-level3">
      Max slippage
      <Segmented
        label="Max slippage"
        value={String(value)}
        onChange={(next) => slippageBps.setState(() => toBps(Number(next)))}
        options={SLIPPAGE_STEPS.map((step) => ({ value: String(step), label: `${step / 100}%` }))}
      />
    </div>
  )
}
