import { useCallback, useId, useRef, useState } from 'react'
import type { ReactNode, Ref, RefObject } from 'react'
import { formatEther, formatUnits } from 'viem'
import type { Hex } from 'viem'
import { DEPOSITS } from '@tape/trade'
import { USDC_DECIMALS, blocksDeposit, parseUsdc } from '@tape/trade/deposit'
import type { DepositFee, DepositIssue, DepositRoute, DepositTerms, DepositVenue } from '@tape/trade/deposit'
import type { AccountRef, Decimal } from '@tape/trade/types'
import { usdcFloor } from '@tape/trade/withdraw'
import { useWalletConnection } from '#/wallet/connection'
import {
  depositRoutes,
  markSeen,
  sendFailure,
  sentHash,
  useDepositQuote,
  useDepositStatuses,
  useDeposits,
  useRouteBalances,
  useSendDeposit,
} from '#/trade/deposit'
import type { SendStep } from '#/trade/deposit'
import { byUrgency, creditDueIn, ended, failed, waits } from '#/trade/deposit-trail'
import type { Followed } from '#/trade/deposit-trail'
import type { DepositRecord } from '#/trade/vault'
import { wagmiConfig } from '#/wallet/config'
import { foldAway, nextFrame, unfold } from '#/wallet/motion'
import { ErrorMark } from './ErrorMark'
import { groupedAmount, shortAddress } from './format'
import { useNow } from './now'
import { Button, Dialog, Input, Select, TextLink } from './primitives'
import { TornEdge } from './TornEdge'

const plain = (units: bigint) => formatUnits(units, USDC_DECIMALS)
const usdc = (units: bigint) => groupedAmount(plain(units))
const chainOf = (id: number) => wagmiConfig.chains.find((chain) => chain.id === id)
const chainName = (id: number) => chainOf(id)?.name ?? `chain ${id}`
const gasText = (wei: bigint, chainId: number) =>
  `${Number(formatEther(wei)).toLocaleString('en-US', { maximumSignificantDigits: 2 })} ${chainOf(chainId)?.nativeCurrency.symbol ?? 'ETH'}`
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB')
const countdown = (ms: number) => {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function DepositButton({ account, available }: { account: AccountRef; available: Decimal | null }) {
  const venue = DEPOSITS[account.venue]
  if (!venue || depositRoutes(account).length === 0) return null
  return <Deposit account={account} venue={venue} available={available === null ? null : usdcFloor(available)} />
}

type Send = ReturnType<typeof useSendDeposit>

interface Entry {
  readonly record: DepositRecord
  readonly followed: Followed
}

function Deposit({
  account,
  venue,
  available,
}: {
  account: AccountRef
  venue: DepositVenue
  available: bigint | null
}) {
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [text, setText] = useState('')
  const [chainId, setChainId] = useState<number | null>(null)
  const [shown, setShown] = useState<Hex | null>(null)
  const deposit = useSendDeposit(account)
  const deposits = useDeposits(account)
  const now = useNow(deposits.some((record) => record.outcome === null))
  const statuses = useDepositStatuses(account, deposits, now, open ? shown : null)
  const entries: readonly Entry[] = deposits.flatMap((record) => {
    const followed = statuses.get(record.hash)
    return followed ? [{ record, followed }] : []
  })
  const waiting = byUrgency(entries.filter((entry) => waits(entry.record, entry.followed, now)))
  const current = entries.find((entry) => entry.record.hash === shown) ?? null
  const trailShown = waiting.length > 0 && (!open || leaving || waiting.some((entry) => entry.record.hash !== shown))

  const amountRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const trailRef = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const backdrop = useRef<HTMLDivElement | null>(null)
  const refocus = useRef(false)
  const from = useRef<DOMRect | null>(null)
  const busy = useRef(false)

  const show = (hash: Hex | null, opener: HTMLElement | null) => {
    if (busy.current) return
    from.current = opener?.getBoundingClientRect() ?? null
    refocus.current = false
    setShown(hash)
    setOpen(true)
  }
  // Base UI leaves the focus on the page when the control that held it unmounts, as the form and the receipt
  // swap in place, so the amount or the close button takes it as it mounts.
  const turnTo = (hash: Hex | null) => {
    refocus.current = popup.current !== null
    setShown(hash)
  }
  const landOn = useCallback((node: HTMLElement | null) => {
    if (!node || !refocus.current) return
    refocus.current = false
    node.focus()
  }, [])
  const amountMounted = useCallback(
    (node: HTMLInputElement | null) => {
      amountRef.current = node
      landOn(node)
    },
    [landOn],
  )
  const grown = useCallback((node: HTMLDivElement | null) => {
    popup.current = node
    if (node && from.current) void unfold(node, backdrop.current, from.current)
    from.current = null
  }, [])
  const close = async () => {
    if (busy.current) return
    busy.current = true
    if (current && ended(current.followed.status)) markSeen(account, current.record.hash)
    setLeaving(true)
    await nextFrame()
    const into = trailRef.current ?? buttonRef.current
    await foldAway(popup.current, backdrop.current, into?.getBoundingClientRect() ?? null)
    setOpen(false)
    setLeaving(false)
    setShown(null)
    busy.current = false
  }

  return (
    <>
      {trailShown && (
        <Trail
          key={waiting[0]?.record.hash}
          ref={trailRef}
          entries={waiting}
          routes={depositRoutes(account)}
          now={now}
          onOpen={show}
        />
      )}
      <Button ref={buttonRef} look="secondary" size="sm" onClick={() => show(null, buttonRef.current)}>
        Deposit
      </Button>
      <Dialog
        open={open}
        onClose={() => void close()}
        title={`Deposit USDC to ${venue.destination}`}
        titleHidden={current !== null}
        width={current ? 'receipt' : 'ledger'}
        initialFocus={amountRef}
        finalFocus={() => trailRef.current ?? buttonRef.current}
        locked={deposit.pending}
        popupRef={grown}
        backdropRef={backdrop}
        well={
          current ? (
            <Receipt key={current.record.hash} account={account} venue={venue} entry={current} now={now} />
          ) : (
            <Draft account={account} venue={venue} available={available} draft={{ text, chainId }} />
          )
        }
      >
        {current ? (
          <>
            <p className="text-level3">{afterText(current.followed, venue)}</p>
            <div className="flex gap-2">
              <Button
                ref={landOn}
                look="secondary-raised"
                size="lg"
                className="flex-1 whitespace-nowrap"
                onClick={() => void close()}
              >
                {ended(current.followed.status) ? 'Close' : 'Close and keep trading'}
              </Button>
              <Button
                look={ended(current.followed.status) ? 'primary' : 'secondary-raised'}
                size="lg"
                className={ended(current.followed.status) ? 'flex-1' : 'whitespace-nowrap'}
                onClick={() => {
                  if (ended(current.followed.status)) markSeen(account, current.record.hash)
                  turnTo(null)
                }}
              >
                New deposit
              </Button>
            </div>
          </>
        ) : (
          <DepositForm
            account={account}
            draft={{ text, setText, chainId, setChainId }}
            deposit={deposit}
            amountRef={amountMounted}
            onSent={(hash) => {
              setText('')
              turnTo(hash)
            }}
          />
        )}
        {entries.length > 0 && (
          <Stubs
            title={current ? 'Deposits' : 'Recent deposits'}
            entries={entries}
            routes={depositRoutes(account)}
            now={now}
            shown={shown}
            onShow={(hash) => {
              if (!deposit.pending) turnTo(hash)
            }}
          />
        )}
      </Dialog>
    </>
  )
}

function afterText({ status }: Followed, venue: DepositVenue): string {
  if (status.stage === 'credited') return 'This slip is your receipt.'
  if (status.stage === 'unresolved')
    return 'Keep this slip. The transaction hash on it is what the venue’s support needs.'
  if (failed(status)) return 'Nothing was deposited.'
  return `You can close this and keep trading. The deposit goes on, and its slip waits beside Deposit in Account until ${venue.destination} credits it.`
}

function useRoute(account: AccountRef, chainId: number | null) {
  const routes = depositRoutes(account)
  const { chainId: walletChain } = useWalletConnection()
  const route =
    routes.find((candidate) => candidate.chainId === chainId)
    ?? routes.find((candidate) => candidate.chainId === walletChain)
    ?? routes[0]!
  return { routes, route, walletChain }
}

const sendingText = (step: SendStep | null, wallet: string, amount: bigint | null, chain: string): string => {
  if (step === 'approving')
    return `Approve exactly ${amount ? usdc(amount) : 'the'} USDC in ${wallet}. It asks once more for the deposit.`
  if (step === 'approval') return `${chain} is confirming the approval. ${wallet} asks for the deposit next.`
  return `Confirm the deposit in ${wallet}.`
}

function DepositForm({
  account,
  draft,
  deposit,
  amountRef,
  onSent,
}: {
  account: AccountRef
  draft: {
    readonly text: string
    readonly setText: (text: string) => void
    readonly chainId: number | null
    readonly setChainId: (chainId: number) => void
  }
  deposit: Send
  amountRef: Ref<HTMLInputElement>
  onSent: (hash: Hex) => void
}) {
  const { routes, route, walletChain } = useRoute(account, draft.chainId)
  const { connector } = useWalletConnection()
  const balances = useRouteBalances(account, routes)
  const balance = balances[routes.indexOf(route)] ?? null
  const amount = parseUsdc(draft.text)
  const quote = useDepositQuote(account, route, amount)
  const fromId = useId()
  const chain = chainName(route.chainId)
  const edit = (text: string) => {
    deposit.reset()
    draft.setText(text)
  }
  return (
    <form
      className="flex flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!amount || !quote.ready || !quote.terms || !quote.calls) return
        deposit.send({ route, amount, terms: quote.terms, calls: quote.calls }, onSent)
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-xs text-level3">
          From
        </label>
        <Select
          size="field"
          id={fromId}
          value={route.chainId}
          disabled={deposit.pending}
          onChange={(value) => {
            deposit.reset()
            draft.setChainId(Number(value))
          }}
        >
          {routes.map((choice, index) => (
            <option key={choice.chainId} value={choice.chainId}>
              {chainName(choice.chainId)}
              {balances[index] !== null && balances[index] !== undefined ? ` · ${usdc(balances[index])} USDC` : ''}
            </option>
          ))}
        </Select>
      </div>
      <Input
        inputRef={amountRef}
        label="Amount"
        name="amount"
        unit="USDC"
        value={draft.text}
        disabled={deposit.pending}
        error={draft.text !== '' && amount === null ? 'A positive amount, at most 6 decimals.' : undefined}
        hint={
          balance !== null && (
            <Button look="quiet" disabled={deposit.pending} onClick={() => edit(plain(balance))}>
              Max {usdc(balance)}
            </Button>
          )
        }
        onChange={edit}
      />
      {!deposit.pending && walletChain !== route.chainId && (
        <p role="status" className="text-level2">
          {connector?.name ?? 'Your wallet'} is on {walletChain ? chainName(walletChain) : 'another network'}. Tape asks
          it to switch to {chain} before you sign.
        </p>
      )}
      {amount !== null && <Issues issues={quote.issues} route={route} messenger={quote.terms?.message?.via ?? null} />}
      {deposit.error && <SendError error={deposit.error} />}
      {deposit.pending && (
        <p role="status" className="flex gap-2 text-level1">
          <span aria-hidden="true" className="mt-0.5 h-2.5 w-1.5 shrink-0 bg-accent motion-safe:animate-caret" />
          <span>
            {sendingText(deposit.step, connector?.name ?? 'your wallet', amount, chain)} Esc stays here until the wallet
            answers, and closing keeps this deposit.
          </span>
        </p>
      )}
      <Button look="primary" size="lg" type="submit" disabled={!quote.ready || deposit.pending} className="mt-auto">
        {deposit.step === 'approving'
          ? `Approve in ${connector?.name ?? 'your wallet'}…`
          : deposit.step === 'approval'
            ? `${chain} is confirming the approval…`
            : deposit.pending
              ? `Waiting for ${connector?.name ?? 'your wallet'}…`
              : amount
                ? `Deposit ${usdc(amount)} USDC from ${chain}`
                : 'Deposit'}
      </Button>
    </form>
  )
}

const feeText = (fee: DepositFee) =>
  fee.expected === fee.max ? `${usdc(fee.max)} USDC` : `About ${usdc(fee.expected)} USDC, at most ${usdc(fee.max)}`

const chargesText = (fee: DepositFee, message: DepositTerms['message'], chainId: number) =>
  [
    ...(fee.max > 0n ? [feeText(fee)] : []),
    ...(message ? [`${gasText(message.wei, chainId)} to ${message.via}`] : []),
  ].join(' and ') || 'None'

function Slip({
  number,
  rows,
  ruleAbove,
  stage,
  washed = false,
  children,
}: {
  number: string
  rows: readonly (readonly [string, ReactNode, string?])[]
  ruleAbove?: number
  stage: string
  washed?: boolean
  children?: ReactNode
}) {
  return (
    <section
      aria-label="Deposit slip"
      data-deposit-stage={stage}
      className={`relative bg-surface px-3 pt-3 pb-4 text-sm text-level2 tabular-nums ${washed ? 'wash' : ''}`}
    >
      <TornEdge />
      <h3 className="flex items-baseline justify-between text-base font-semibold text-level1">
        Deposit
        <span className="num text-xs font-normal text-level3">{number}</span>
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([label, value, className = ''], index) => (
          <div
            key={label}
            className={`col-span-2 grid grid-cols-subgrid ${index === ruleAbove ? 'mt-1 border-t border-dashed border-edge/60 pt-2.5' : ''}`}
          >
            <dt className="text-level3">{label}</dt>
            <dd className={`text-right text-level1 ${className}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  )
}

const KEY = 'text-base font-medium'

function Draft({
  account,
  venue,
  available,
  draft,
}: {
  account: AccountRef
  venue: DepositVenue
  available: bigint | null
  draft: { readonly text: string; readonly chainId: number | null }
}) {
  const { route } = useRoute(account, draft.chainId)
  const amount = parseUsdc(draft.text)
  const quote = useDepositQuote(account, route, amount)
  const fee = quote.terms?.fee ?? null
  const chain = chainName(route.chainId)
  const lost = quote.issues.some((issue) => issue.kind === 'below-minimum' && issue.lost)
  const exact = fee !== null && fee.expected === fee.max
  const rows: [string, ReactNode, string?][] = [
    ['Route', [chain, ...route.hops, venue.destination].join(' → ')],
    [
      'Credited to',
      <span key="credited">
        <span className="num">{shortAddress(account.owner)}</span>, the same address
      </span>,
    ],
    [
      'Fee',
      quote.terms
        ? chargesText(quote.terms.fee, quote.terms.message, route.chainId)
        : quote.termsError
          ? 'Unavailable'
          : '—',
    ],
    [
      'You receive',
      lost
        ? 'Nothing, under the minimum'
        : amount && fee
          ? exact
            ? `${usdc(amount - fee.max)} USDC`
            : `About ${usdc(amount - fee.expected)} USDC, at least ${usdc(amount - fee.max)}`
          : '—',
      lost ? 'text-err' : KEY,
    ],
    [
      'Available after',
      available !== null && amount && fee && !lost ? `About ${usdc(available + amount - fee.expected)} USDC` : '—',
    ],
    ['Gas', quote.gasCost !== null ? `About ${gasText(quote.gasCost, route.chainId)} on ${chain}` : '—'],
    [
      'Time',
      `${route.eta.typical <= 60 ? 'Under a minute' : `About ${minutes(route.eta.typical)} min`}, at most ${minutes(route.eta.worst)} min`,
    ],
    [
      'Wallet asks',
      quote.calls
        ? quote.calls.length > 1 && amount
          ? `Twice: approve exactly ${usdc(amount)} USDC, then deposit`
          : 'Once, for the deposit'
        : '—',
    ],
  ]
  return <Slip number="draft" rows={rows} stage="draft" />
}

function issueText(issue: DepositIssue, route: DepositRoute, messenger: string | null): string {
  const chain = chainName(route.chainId)
  switch (issue.kind) {
    case 'below-minimum':
      return issue.lost
        ? `Deposits under ${usdc(issue.minimum)} USDC on this route are kept and never credited. Send at least ${usdc(issue.minimum)}.`
        : `Send at least ${usdc(issue.minimum)} USDC.`
    case 'fee-exceeds-amount':
      return `The fee can reach ${usdc(issue.fee)} USDC, which leaves nothing to credit.`
    case 'insufficient-usdc':
      return `The wallet has ${usdc(issue.balance)} USDC on ${chain}.`
    case 'insufficient-gas':
      return `${messenger ? `Gas and the ${messenger} fee need` : 'Gas needs'} about ${gasText(issue.need, route.chainId)} on ${chain}. The wallet has ${gasText(issue.have, route.chainId)}.`
    case 'contract-wallet':
      return `This address is a contract on ${chain}. The venue credits the same address, and a contract wallet cannot sign there. Deposit from a regular wallet.`
    case 'chain-rejects':
      return `${chain} would reject this transaction: ${issue.reason}. Nothing was sent.`
    case 'high-fee':
      return `The fee should be about ${(issue.bps / 100).toFixed(2)}% of this deposit.`
    case 'no-account':
      return 'The venue has no account for this address yet. Enable trading first, which registers it, then deposit.'
    case 'over-limit':
      return `The venue's vault on ${chain} takes ${usdc(issue.room)} USDC more right now. Send less, or deposit from another chain.`
  }
}

function Issues({
  issues,
  route,
  messenger,
}: {
  issues: readonly DepositIssue[]
  route: DepositRoute
  messenger: string | null
}) {
  if (issues.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue) => (
        <li
          key={issue.kind}
          data-deposit-issue={issue.kind}
          className={blocksDeposit(issue) ? 'flex gap-1.5 text-level1' : 'text-level2'}
        >
          {blocksDeposit(issue) && <ErrorMark />}
          <span role={blocksDeposit(issue) ? 'alert' : 'status'}>{issueText(issue, route, messenger)}</span>
        </li>
      ))}
    </ul>
  )
}

function SendError({ error }: { error: Error }) {
  const failure = sendFailure(error)
  return (
    <div role="alert" data-deposit-error={failure.kind} className="flex gap-1.5 text-level2">
      <ErrorMark />
      <div className="min-w-0">
        <p className="text-level1">
          {failure.approved
            ? `${failure.kind === 'wallet-rejected' ? 'You declined the deposit in the wallet' : 'The deposit was not sent'}. The approval went through, so the next try asks for the deposit only.`
            : failure.kind === 'wallet-rejected'
              ? 'You declined in the wallet. Nothing was sent.'
              : 'The deposit was not sent.'}
        </p>
        {failure.kind === 'failed' && <p className="mt-1 text-xs break-all text-level3">{failure.detail}</p>}
      </div>
    </div>
  )
}

function TxLink({ chainId, hash }: { chainId: number; hash: string }) {
  const explorer = chainOf(chainId)?.blockExplorers.default
  return explorer ? (
    <TextLink href={`${explorer.url}/tx/${hash}`} newTab>
      {explorer.name} {shortAddress(hash)}
    </TextLink>
  ) : (
    <span>{shortAddress(hash)}</span>
  )
}

function Line({
  label,
  value,
  tone = '',
  children,
}: {
  label: ReactNode
  value?: ReactNode
  tone?: string
  children?: ReactNode
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className={tone}>{label}</span>
        {value !== undefined && <span className="num text-level2">{value}</span>}
      </span>
      {children !== undefined && <span className="text-xs text-level3">{children}</span>}
    </span>
  )
}

function Receipt({
  account,
  venue,
  entry,
  now,
}: {
  account: AccountRef
  venue: DepositVenue
  entry: Entry
  now: number
}) {
  const { record, followed } = entry
  const { status, late } = followed
  const route = depositRoutes(account).find((candidate) => candidate.chainId === record.chainId)
  const chain = chainName(record.chainId)
  const credited = status.stage === 'credited' ? status : null
  const arrived = useTurned(credited !== null)
  const kept = credited ? record.amount - credited.amount : null
  const rows: [string, ReactNode, string?][] = [
    ['From', chain],
    ['Via', route ? route.hops.join(' → ') : '—'],
    ['To', venue.destination],
    [
      'Address',
      <span key="address">
        <span className="num">{shortAddress(account.owner)}</span>, on both
      </span>,
    ],
    ['Amount', `${usdc(record.amount)} USDC`],
    [
      'Fee',
      kept === null
        ? chargesText(record.fee, record.message, record.chainId)
        : [
            `${usdc(kept)} USDC`,
            ...(record.message ? [`${gasText(record.message.wei, record.chainId)} to ${record.message.via}`] : []),
          ].join(' and '),
    ],
    credited
      ? ['Credited', `${usdc(credited.amount)} USDC`, KEY]
      : [
          'You receive',
          failed(status)
            ? 'Nothing'
            : `${record.fee.expected === record.fee.max ? '' : 'About '}${usdc(record.amount - record.fee.expected)} USDC`,
          KEY,
        ],
  ]
  const lines: [string, ReactNode, boolean?][] = [
    [
      'sent',
      <Line key="sent" label={`Sent from ${chain}`} value={clock(record.sentAt)}>
        <TxLink chainId={record.chainId} hash={sentHash(record)} />
      </Line>,
    ],
  ]
  if (record.gasPaid !== null)
    lines.push([
      'confirmed',
      <Line
        key="confirmed"
        label={`Confirmed on ${chain}`}
        value={record.confirmedAt === null ? undefined : clock(record.confirmedAt)}
      />,
    ])
  if (status.stage === 'confirming')
    lines.push([
      'confirming',
      <span key="confirming" role="status" className="flex items-center gap-1.5">
        Waiting for {chain} to confirm
        <span aria-hidden="true" className="h-2.5 w-1.5 bg-accent motion-safe:animate-caret" />
      </span>,
    ])
  if (status.stage === 'relaying') {
    const left = route ? creditDueIn(record, route, now) : 0
    lines.push([
      'relaying',
      <span key="relaying" role="status">
        <Line
          label={left > 0 ? 'Credit due in' : `Due now, waiting for ${venue.destination}`}
          value={left > 0 ? countdown(left) : undefined}
        >
          {status.detail}
        </Line>
      </span>,
    ])
  }
  if (status.stage === 'unwatched')
    lines.push([
      'unwatched',
      <span key="unwatched" role="status">
        <Line label="Tape cannot follow the credit from here." tone="text-warn">
          {status.detail}
        </Line>
      </span>,
    ])
  if (late && route && !ended(status))
    lines.push([
      'late',
      <span key="late" role="alert" data-deposit-late>
        <Line
          label={`Not ${status.stage === 'confirming' ? 'confirmed' : 'credited'} after ${minutes(route.eta.worst)} min, longer than this route takes.`}
          tone="text-warn"
        >
          {status.stage === 'confirming'
            ? `${chain} has not confirmed the transaction yet. Check it in the explorer before sending again.`
            : `${chain} confirmed it, so the USDC left the wallet. Keep this receipt: the transaction hash is what the venue's support needs.`}
        </Line>
      </span>,
    ])
  if (failed(status))
    lines.push([
      'failed',
      <span key="failed" role="alert" className="flex gap-1.5">
        <ErrorMark />
        <Line
          label={
            status.stage === 'reverted'
              ? `Reverted on ${chain}. The USDC stayed in the wallet.`
              : `The wallet replaced this transaction on ${chain}. Nothing was deposited.`
          }
        >
          {status.stage === 'reverted' ? 'The gas was spent.' : 'Check the wallet’s activity before you deposit again.'}
        </Line>
      </span>,
    ])
  if (status.stage === 'unresolved')
    lines.push([
      'unresolved',
      <span key="unresolved" role="alert">
        <Line label={`Check manually. ${status.detail}`} tone="text-warn">
          Open the{' '}
          <TextLink href={status.check.url} newTab>
            {status.check.label}
          </TextLink>
          , or give support the source transaction hash:
          <span className="num mt-0.5 block break-all text-level1">{sentHash(record)}</span>
        </Line>
      </span>,
    ])
  if (credited) {
    lines.push([
      'credited',
      <span key="credited" role="status">
        <Line label={`Credited ${usdc(credited.amount)} USDC`} value={clock(credited.at)} />
      </span>,
    ])
    lines.push([
      'record',
      <Line key="record" label={`${venue.destination} record`} value={shortAddress(credited.receipt)} />,
    ])
  }
  return (
    <Slip number={`#${record.hash.slice(2, 8)}`} rows={rows} ruleAbove={4} stage={status.stage} washed={arrived}>
      <ol key={lines.length} aria-label="Answers" className="mt-3 flex flex-col gap-1.5 motion-safe:animate-slip-feed">
        {lines.map(([key, line], index) => (
          <li
            key={key}
            className={`border-t border-rule pt-1.5 text-level1 ${index === lines.length - 1 ? 'motion-safe:animate-print' : ''}`}
          >
            {line}
          </li>
        ))}
      </ol>
    </Slip>
  )
}

function useTurned(on: boolean): boolean {
  const [seen, setSeen] = useState({ first: on, turned: false })
  if (on && !seen.first && !seen.turned) setSeen({ first: false, turned: true })
  return seen.turned
}

function stubWord({ record, followed }: Entry, route: DepositRoute | undefined, now: number): ReactNode {
  const { status, late } = followed
  switch (status.stage) {
    case 'credited':
      return 'Credited'
    case 'reverted':
      return <span className="text-err">Reverted</span>
    case 'replaced':
      return <span className="text-err">Replaced</span>
    case 'unresolved':
      return <span className="text-warn">Check manually</span>
    case 'unwatched':
      return <span className="text-warn">Not followed</span>
    case 'confirming':
    case 'relaying': {
      if (late) return <span className="text-warn">Late</span>
      const left = route && status.stage === 'relaying' ? creditDueIn(record, route, now) : 0
      return left > 0 ? countdown(left) : 'In progress'
    }
  }
}

function Stubs({
  title,
  entries,
  routes,
  now,
  shown,
  onShow,
}: {
  title: string
  entries: readonly Entry[]
  routes: readonly DepositRoute[]
  now: number
  shown: Hex | null
  onShow: (hash: Hex) => void
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1 border-t border-rule pt-3">
      <h3 className="text-xs text-level3">{title}</h3>
      <ul className="-mx-2 flex flex-col gap-0.5">
        {entries.slice(0, 4).map((entry) => (
          <li key={entry.record.hash}>
            <Button
              look="row"
              aria-current={entry.record.hash === shown}
              onClick={() => onShow(entry.record.hash)}
              className="flex w-full justify-between gap-3 rounded-md px-2 py-1.5 tabular-nums aria-current:bg-option-hover"
            >
              <span>
                {usdc(entry.record.amount)} USDC · {chainName(entry.record.chainId)} · {clock(entry.record.sentAt)}
              </span>
              <span>
                {stubWord(
                  entry,
                  routes.find((route) => route.chainId === entry.record.chainId),
                  now,
                )}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function trailText(entries: readonly Entry[], routes: readonly DepositRoute[], now: number) {
  const [first] = entries
  if (!first) return null
  const { record, followed } = first
  const { status, late } = followed
  const amount = usdc(record.amount)
  const route = routes.find((candidate) => candidate.chainId === record.chainId)
  const several = entries.length > 1 ? `${entries.length} deposits` : null
  switch (status.stage) {
    case 'credited':
      return { label: several ?? `Credited ${usdc(status.amount)} USDC`, figure: several && 'one credited', tone: '' }
    case 'reverted':
    case 'replaced':
      return {
        label: several ?? `Deposit of ${amount} USDC ${status.stage}`,
        figure: several && 'one failed',
        tone: 'text-warn',
        failed: true,
      }
    case 'unresolved':
      return { label: several ?? `Deposit of ${amount} USDC`, figure: 'check', tone: 'text-warn' }
    case 'unwatched':
      return { label: several ?? `Depositing ${amount} USDC`, figure: 'not followed', tone: 'text-warn' }
    case 'confirming':
      return {
        label: several ?? `Depositing ${amount} USDC`,
        figure: late ? 'late' : 'confirming',
        tone: late ? 'text-warn' : 'text-level2',
      }
    case 'relaying': {
      const left = route ? creditDueIn(record, route, now) : 0
      return {
        label: several ?? `Depositing ${amount} USDC`,
        figure: late ? 'late' : left > 0 ? countdown(left) : 'due',
        tone: late ? 'text-warn' : 'text-level2',
      }
    }
  }
}

function Trail({
  ref,
  entries,
  routes,
  now,
  onOpen,
}: {
  ref: RefObject<HTMLButtonElement | null>
  entries: readonly Entry[]
  routes: readonly DepositRoute[]
  now: number
  onOpen: (hash: Hex, opener: HTMLElement | null) => void
}) {
  const [first] = entries
  const text = trailText(entries, routes, now)
  const arrived = useTurned(first?.followed.status.stage === 'credited')
  if (!first || !text) return null
  return (
    <Button
      ref={ref}
      look="secondary"
      size="sm"
      onClick={() => onOpen(first.record.hash, ref.current)}
      className={`flex items-center gap-2 ${arrived ? 'wash' : ''}`}
    >
      {text.failed && <ErrorMark className="size-3.5 shrink-0" />}
      {text.label}
      {text.figure && <span className={`num ${text.tone}`}>{text.figure}</span>}
    </Button>
  )
}
