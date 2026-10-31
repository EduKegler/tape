import { useEffect, useId, useState } from 'react'
import { useConnection } from 'wagmi'
import { formatEther, formatUnits } from 'viem'
import type { Hex } from 'viem'
import { DEPOSITS } from '@tape/trade'
import { USDC_DECIMALS, blocksDeposit, parseUsdc } from '@tape/trade/deposit'
import type { DepositFee, DepositIssue, DepositRoute, DepositVenue } from '@tape/trade/deposit'
import type { AccountRef } from '@tape/trade/types'
import {
  depositRoutes,
  sendFailure,
  sentHash,
  useDepositQuote,
  useDepositStatus,
  useDeposits,
  useRouteBalances,
  useSendDeposit,
} from '#/trade/deposit'
import type { DepositQuote, DepositStatus } from '#/trade/deposit'
import type { DepositRecord } from '#/trade/vault'
import { wagmiConfig } from '#/wallet/config'
import { shortAddress } from './format'
import { Button } from './primitives'

const usdc = (units: bigint) => formatUnits(units, USDC_DECIMALS)
const chainOf = (id: number) => wagmiConfig.chains.find((c) => c.id === id)
const chainName = (id: number) => chainOf(id)?.name ?? `chain ${id}`
const gasText = (wei: bigint, chainId: number) =>
  `${Number(formatEther(wei)).toLocaleString('en-US', { maximumSignificantDigits: 2 })} ${chainOf(chainId)?.nativeCurrency.symbol ?? 'ETH'}`
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB')

export function DepositButton({ account }: { account: AccountRef }) {
  const [open, setOpen] = useState(false)
  const venue = DEPOSITS[account.venue]
  if (!venue || depositRoutes(account).length === 0) return null
  return (
    <>
      <Button look="primary" size="sm" onClick={() => setOpen(true)}>
        Deposit
      </Button>
      {open && <DepositDialog account={account} venue={venue} onClose={() => setOpen(false)} />}
    </>
  )
}

function DepositDialog({ account, venue, onClose }: { account: AccountRef; venue: DepositVenue; onClose: () => void }) {
  const titleId = useId()
  const deposits = useDeposits(account)
  const [shown, setShown] = useState<Hex | null>(null)
  const record = deposits.find((d) => d.hash === shown)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-dialog flex items-center justify-center bg-black/60 motion-safe:animate-fade-in">
      <div
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        className="flex max-h-[90vh] w-104 flex-col gap-3 overflow-auto rounded-sm border border-rule bg-raised p-4 text-sm"
      >
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-base text-level1">
            Deposit USDC to {venue.destination}
          </h2>
          <Button look="quiet" onClick={onClose} aria-label="Close">
            ×
          </Button>
        </div>
        {record ? (
          <>
            <Receipt account={account} venue={venue} record={record} />
            <Button look="quiet" onClick={() => setShown(null)} className="self-start">
              New deposit
            </Button>
          </>
        ) : (
          <DepositForm account={account} venue={venue} onSent={setShown} />
        )}
        {deposits.length > 0 && <Recent account={account} deposits={deposits} shown={shown} onShow={setShown} />}
      </div>
    </div>
  )
}

function DepositForm({
  account,
  venue,
  onSent,
}: {
  account: AccountRef
  venue: DepositVenue
  onSent: (hash: Hex) => void
}) {
  const routes = depositRoutes(account)
  const balances = useRouteBalances(account, routes)
  const { chainId: walletChain } = useConnection()
  const [chainId, setChainId] = useState(
    () => routes.find((r) => r.chainId === walletChain)?.chainId ?? routes[0]!.chainId,
  )
  const route = routes.find((r) => r.chainId === chainId) ?? routes[0]!
  const balance = balances[routes.indexOf(route)] ?? null
  const [text, setText] = useState('')
  const amount = parseUsdc(text)
  const quote = useDepositQuote(account, route, amount)
  const send = useSendDeposit(account)
  const fromId = useId()
  const amountId = useId()
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!amount || !quote.ready || !quote.terms || !quote.calls || send.isPending) return
        send.mutate({ route, amount, terms: quote.terms, calls: quote.calls }, { onSuccess: onSent })
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-level3">
          From
        </label>
        <select
          id={fromId}
          value={chainId}
          onChange={(e) => {
            send.reset()
            setChainId(Number(e.target.value))
          }}
          className="rounded-sm border border-rule bg-surface px-2 py-1.5 text-level1"
        >
          {routes.map((r, i) => (
            <option key={r.chainId} value={r.chainId}>
              {chainName(r.chainId)}
              {balances[i] !== null && balances[i] !== undefined ? ` · ${usdc(balances[i])} USDC` : ''}
            </option>
          ))}
        </select>
      </div>
      {walletChain !== route.chainId && (
        <p role="status" className="text-level2">
          Your wallet is on {walletChain ? chainName(walletChain) : 'another network'}. Tape asks it to switch to{' '}
          {chainName(route.chainId)} before you sign.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-level3">
          <label htmlFor={amountId}>Amount (USDC)</label>
          {balance !== null && (
            <Button
              look="quiet"
              onClick={() => {
                send.reset()
                setText(usdc(balance))
              }}
            >
              Max {usdc(balance)}
            </Button>
          )}
        </div>
        <input
          id={amountId}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            send.reset()
            setText(e.target.value.trim())
          }}
          aria-invalid={text !== '' && amount === null}
          className="num rounded-sm border border-rule bg-surface px-2 py-1.5 text-base text-level1 outline-none focus:border-ink aria-invalid:border-ask"
        />
        {text !== '' && amount === null && <span className="text-ask">A positive amount, at most 6 decimals.</span>}
      </div>
      <Summary account={account} venue={venue} route={route} amount={amount} quote={quote} />
      {amount !== null && <Issues issues={quote.issues} route={route} messenger={quote.terms?.message?.via ?? null} />}
      <Button look="primary" size="lg" type="submit" disabled={!quote.ready || send.isPending}>
        {send.isPending
          ? 'Confirm in your wallet…'
          : amount
            ? `Deposit ${usdc(amount)} USDC from ${chainName(route.chainId)}`
            : 'Deposit'}
      </Button>
      {send.error && <SendError error={send.error} />}
    </form>
  )
}

const feeText = (fee: DepositFee) =>
  fee.expected === fee.max ? `${usdc(fee.max)} USDC` : `≈${usdc(fee.expected)} USDC, at most ${usdc(fee.max)}`

function Summary({
  account,
  venue,
  route,
  amount,
  quote,
}: {
  account: AccountRef
  venue: DepositVenue
  route: DepositRoute
  amount: bigint | null
  quote: DepositQuote
}) {
  const fee = quote.terms?.fee ?? null
  const message = quote.terms?.message ?? null
  const charges = [
    ...(fee && fee.max > 0n ? [feeText(fee)] : []),
    ...(message ? [`${gasText(message.wei, route.chainId)} to ${message.via}`] : []),
  ]
  const rows: [string, string][] = [
    ['Route', [chainName(route.chainId), ...route.hops, venue.destination].join(' → ')],
    ['Credited to', `${shortAddress(account.owner)}, the same address`],
    ['Fee', quote.terms ? charges.join(' and ') || 'None' : quote.termsError ? 'Unavailable' : '…'],
    [
      'You receive',
      quote.issues.some((i) => i.kind === 'below-minimum' && i.lost)
        ? 'Nothing, under the minimum'
        : amount && fee
          ? fee.expected === fee.max
            ? `${usdc(amount - fee.max)} USDC`
            : `≈${usdc(amount - fee.expected)} USDC, at least ${usdc(amount - fee.max)}`
          : '…',
    ],
    ['Gas', quote.gasCost !== null ? `≈${gasText(quote.gasCost, route.chainId)} on ${chainName(route.chainId)}` : '…'],
    [
      'Time',
      `${route.eta.typical <= 60 ? 'Under a minute' : `About ${minutes(route.eta.typical)} min`}, up to ${minutes(route.eta.worst)} min`,
    ],
    [
      'Wallet asks',
      quote.calls
        ? quote.calls.length > 1 && amount
          ? `Approve exactly ${usdc(amount)} USDC, then deposit`
          : 'One transaction'
        : '…',
    ],
  ]
  return (
    <dl aria-label="Deposit summary" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-level3">{k}</dt>
          <dd className="num text-right text-level1">{v}</dd>
        </div>
      ))}
    </dl>
  )
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
      return `The fee is ${(issue.bps / 100).toFixed(2)}% of this deposit.`
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
          className={`rounded-sm border p-2 ${blocksDeposit(issue) ? 'border-ask/40 text-ask' : 'border-rule text-level2'}`}
        >
          <span role={blocksDeposit(issue) ? 'alert' : 'status'}>{issueText(issue, route, messenger)}</span>
        </li>
      ))}
    </ul>
  )
}

function SendError({ error }: { error: Error }) {
  const failure = sendFailure(error)
  return (
    <div role="alert" data-deposit-error={failure.kind} className="rounded-sm border border-ask/40 p-2 text-level2">
      <p className="text-ask">
        {failure.approved
          ? `${failure.kind === 'wallet-rejected' ? 'You declined the deposit in the wallet' : 'The deposit was not sent'}. The approval went through, so the next try asks for the deposit only.`
          : failure.kind === 'wallet-rejected'
            ? 'You declined in the wallet. Nothing was sent.'
            : 'The deposit was not sent.'}
      </p>
      {failure.kind === 'failed' && <p className="num mt-1 text-xs break-all text-level3">{failure.detail}</p>}
    </div>
  )
}

function TxLink({ chainId, hash }: { chainId: number; hash: string }) {
  const explorer = chainOf(chainId)?.blockExplorers.default.url
  return explorer ? (
    <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {shortAddress(hash)}
    </a>
  ) : (
    <span>{shortAddress(hash)}</span>
  )
}

const stageText = (status: DepositStatus, chain: string, destination: string) => {
  switch (status.stage) {
    case 'confirming':
      return `Waiting for ${chain} to confirm`
    case 'reverted':
      return `Reverted on ${chain}. The USDC stayed in the wallet`
    case 'replaced':
      return `The wallet replaced this transaction on ${chain}. Nothing was deposited`
    case 'relaying':
      return status.detail
    case 'unresolved':
      return `Check manually. ${status.detail}`
    case 'credited':
      return `Credited to ${destination} at ${clock(status.at)}`
  }
}

function Receipt({ account, venue, record }: { account: AccountRef; venue: DepositVenue; record: DepositRecord }) {
  const { status, late } = useDepositStatus(account, record)
  const route = depositRoutes(account).find((r) => r.chainId === record.chainId)
  const chain = chainName(record.chainId)
  const credited = status.stage === 'credited' ? status : null
  const failed = status.stage === 'reverted' || status.stage === 'replaced'
  const ended = credited !== null || failed || status.stage === 'unresolved'
  const rows: [string, React.ReactNode][] = [
    ['Sent', `${usdc(record.amount)} USDC from ${chain} at ${clock(record.sentAt)}`],
    ['Transaction', <TxLink key="tx" chainId={record.chainId} hash={sentHash(record)} />],
    ['Gas paid', record.gasPaid !== null ? gasText(record.gasPaid, record.chainId) : '…'],
    [
      'Fee',
      credited ? `${usdc(record.amount - credited.amount)} USDC` : record.fee.max === 0n ? 'None' : feeText(record.fee),
    ],
    ['Credited', credited ? `${usdc(credited.amount)} USDC` : '…'],
    ...(credited ? [['Venue record', shortAddress(credited.receipt)] as [string, string]] : []),
  ]
  return (
    <section aria-label="Deposit receipt" data-deposit-stage={status.stage} className="flex flex-col gap-2">
      <p
        role={failed || status.stage === 'unresolved' ? 'alert' : 'status'}
        className={status.stage === 'credited' ? 'text-bid' : failed ? 'text-ask' : 'text-level1'}
      >
        {stageText(status, chain, venue.destination)}
      </p>
      {status.stage === 'unresolved' && <CheckManually check={status.check} hash={sentHash(record)} />}
      {late && route && !ended && (
        <p role="alert" data-deposit-late className="rounded-sm border border-ask/40 p-2 text-level2">
          Not credited after {minutes(route.eta.worst)} min, longer than this route takes.{' '}
          {status.stage === 'confirming'
            ? `${chain} has not confirmed the transaction yet. Check it in the explorer before sending again.`
            : `${chain} confirmed it, so the USDC left the wallet. Keep this receipt: the transaction hash is what the venue's support needs.`}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-level3">{k}</dt>
            <dd className="num text-right text-level1">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function CheckManually({ check, hash }: { check: { label: string; url: string }; hash: string }) {
  return (
    <div className="rounded-sm border border-ask/40 p-2 text-level2">
      <p>
        Open the{' '}
        <a href={check.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {check.label}
        </a>
        , or give support the source transaction hash:
      </p>
      <p className="num mt-1 text-xs break-all text-level1">{hash}</p>
    </div>
  )
}

function Recent({
  account,
  deposits,
  shown,
  onShow,
}: {
  account: AccountRef
  deposits: readonly DepositRecord[]
  shown: Hex | null
  onShow: (hash: Hex) => void
}) {
  return (
    <section aria-label="Recent deposits" className="flex flex-col gap-1 border-t border-rule pt-2">
      <h3 className="text-level3">Recent deposits</h3>
      <ul className="flex flex-col">
        {deposits.slice(0, 5).map((d) => (
          <RecentRow key={d.hash} account={account} record={d} current={d.hash === shown} onShow={onShow} />
        ))}
      </ul>
    </section>
  )
}

function RecentRow({
  account,
  record,
  current,
  onShow,
}: {
  account: AccountRef
  record: DepositRecord
  current: boolean
  onShow: (hash: Hex) => void
}) {
  const { status, late } = useDepositStatus(account, record)
  const label =
    status.stage === 'credited'
      ? 'Credited'
      : status.stage === 'reverted'
        ? 'Reverted'
        : status.stage === 'replaced'
          ? 'Replaced'
          : status.stage === 'unresolved'
            ? 'Check manually'
            : late
              ? 'Late'
              : 'In progress'
  return (
    <li>
      <Button
        look="row"
        aria-current={current}
        onClick={() => onShow(record.hash)}
        className="num flex w-full justify-between py-0.5"
      >
        <span>
          {usdc(record.amount)} USDC · {chainName(record.chainId)} · {clock(record.sentAt)}
        </span>
        <span>{label}</span>
      </Button>
    </li>
  )
}
