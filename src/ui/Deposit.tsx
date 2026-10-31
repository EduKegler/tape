import { useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useConnection } from 'wagmi'
import { formatEther, formatUnits } from 'viem'
import type { Hex } from 'viem'
import { DEPOSITS } from '@tape/trade'
import { USDC_DECIMALS, blocksDeposit, parseUsdc } from '@tape/trade/deposit'
import type { DepositFee, DepositIssue, DepositRoute, DepositTerms, DepositVenue } from '@tape/trade/deposit'
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
import { Button, Dialog, Input } from './primitives'

const usdc = (units: bigint) => formatUnits(units, USDC_DECIMALS)
const chainOf = (id: number) => wagmiConfig.chains.find((chain) => chain.id === id)
const chainName = (id: number) => chainOf(id)?.name ?? `chain ${id}`
const gasText = (wei: bigint, chainId: number) =>
  `${Number(formatEther(wei)).toLocaleString('en-US', { maximumSignificantDigits: 2 })} ${chainOf(chainId)?.nativeCurrency.symbol ?? 'ETH'}`
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB')

export function DepositButton({ account }: { account: AccountRef }) {
  const venue = DEPOSITS[account.venue]
  if (!venue || depositRoutes(account).length === 0) return null
  return <Deposit account={account} venue={venue} />
}

type Send = ReturnType<typeof useSendDeposit>

interface Draft {
  readonly text: string
  readonly setText: (text: string) => void
  readonly chainId: number | null
  readonly setChainId: (chainId: number) => void
  readonly shown: Hex | null
  readonly setShown: (hash: Hex | null) => void
}

function Deposit({ account, venue }: { account: AccountRef; venue: DepositVenue }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [chainId, setChainId] = useState<number | null>(null)
  const [shown, setShown] = useState<Hex | null>(null)
  const deposit = useSendDeposit(account)
  const amountRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button look="primary" size="sm" onClick={() => setOpen(true)}>
        Deposit
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Deposit USDC to ${venue.destination}`}
        initialFocus={amountRef}
        lockReason={
          deposit.pending
            ? 'Confirm in your wallet. Esc stays here until you answer it, and closing keeps this deposit.'
            : null
        }
      >
        <DepositBody
          account={account}
          venue={venue}
          draft={{ text, setText, chainId, setChainId, shown, setShown }}
          deposit={deposit}
          amountRef={amountRef}
        />
      </Dialog>
    </>
  )
}

function DepositBody({
  account,
  venue,
  draft,
  deposit,
  amountRef,
}: {
  account: AccountRef
  venue: DepositVenue
  draft: Draft
  deposit: Send
  amountRef: RefObject<HTMLInputElement | null>
}) {
  const deposits = useDeposits(account)
  const record = deposits.find((entry) => entry.hash === draft.shown)
  return (
    <>
      {record ? (
        <>
          <Receipt account={account} venue={venue} record={record} />
          <Button look="quiet" onClick={() => draft.setShown(null)} className="self-start">
            New deposit
          </Button>
        </>
      ) : (
        <DepositForm account={account} venue={venue} draft={draft} deposit={deposit} amountRef={amountRef} />
      )}
      {deposits.length > 0 && (
        <Recent account={account} deposits={deposits} shown={draft.shown} onShow={draft.setShown} />
      )}
    </>
  )
}

function DepositForm({
  account,
  venue,
  draft,
  deposit,
  amountRef,
}: {
  account: AccountRef
  venue: DepositVenue
  draft: Draft
  deposit: Send
  amountRef: RefObject<HTMLInputElement | null>
}) {
  const routes = depositRoutes(account)
  const balances = useRouteBalances(account, routes)
  const { chainId: walletChain } = useConnection()
  const route =
    routes.find((candidate) => candidate.chainId === draft.chainId)
    ?? routes.find((candidate) => candidate.chainId === walletChain)
    ?? routes[0]!
  const balance = balances[routes.indexOf(route)] ?? null
  const amount = parseUsdc(draft.text)
  const quote = useDepositQuote(account, route, amount)
  const fromId = useId()
  const edit = (text: string) => {
    deposit.reset()
    draft.setText(text)
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!amount || !quote.ready || !quote.terms || !quote.calls) return
        deposit.send({ route, amount, terms: quote.terms, calls: quote.calls }, (hash) => {
          draft.setText('')
          draft.setShown(hash)
        })
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-level3">
          From
        </label>
        <select
          id={fromId}
          value={route.chainId}
          disabled={deposit.pending}
          onChange={(event) => {
            deposit.reset()
            draft.setChainId(Number(event.target.value))
          }}
          className="h-9 rounded-sm border border-edge bg-inset px-2 text-base text-level1"
        >
          {routes.map((choice, index) => (
            <option key={choice.chainId} value={choice.chainId}>
              {chainName(choice.chainId)}
              {balances[index] !== null && balances[index] !== undefined ? ` · ${usdc(balances[index])} USDC` : ''}
            </option>
          ))}
        </select>
      </div>
      {!deposit.pending && walletChain !== route.chainId && (
        <p role="status" className="text-level2">
          Your wallet is on {walletChain ? chainName(walletChain) : 'another network'}. Tape asks it to switch to{' '}
          {chainName(route.chainId)} before you sign.
        </p>
      )}
      <Input
        inputRef={amountRef}
        label="Amount (USDC)"
        name="amount"
        value={draft.text}
        disabled={deposit.pending}
        error={draft.text !== '' && amount === null ? 'A positive amount, at most 6 decimals.' : undefined}
        hint={
          balance !== null && (
            <Button look="quiet" disabled={deposit.pending} onClick={() => edit(usdc(balance))}>
              Max {usdc(balance)}
            </Button>
          )
        }
        onChange={edit}
      />
      <Summary account={account} venue={venue} route={route} amount={amount} quote={quote} />
      {amount !== null && <Issues issues={quote.issues} route={route} messenger={quote.terms?.message?.via ?? null} />}
      <Button look="primary" size="lg" type="submit" disabled={!quote.ready || deposit.pending}>
        {deposit.pending
          ? 'Waiting for your wallet…'
          : amount
            ? `Deposit ${usdc(amount)} USDC from ${chainName(route.chainId)}`
            : 'Deposit'}
      </Button>
      {deposit.error && <SendError error={deposit.error} />}
    </form>
  )
}

const feeText = (fee: DepositFee) =>
  fee.expected === fee.max ? `${usdc(fee.max)} USDC` : `≈${usdc(fee.expected)} USDC, at most ${usdc(fee.max)}`

const chargesText = (fee: DepositFee, message: DepositTerms['message'], chainId: number) =>
  [
    ...(fee.max > 0n ? [feeText(fee)] : []),
    ...(message ? [`${gasText(message.wei, chainId)} to ${message.via}`] : []),
  ].join(' and ') || 'None'

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
  const rows: [string, string][] = [
    ['Route', [chainName(route.chainId), ...route.hops, venue.destination].join(' → ')],
    ['Credited to', `${shortAddress(account.owner)}, the same address`],
    [
      'Fee',
      quote.terms
        ? chargesText(quote.terms.fee, quote.terms.message, route.chainId)
        : quote.termsError
          ? 'Unavailable'
          : '…',
    ],
    [
      'You receive',
      quote.issues.some((issue) => issue.kind === 'below-minimum' && issue.lost)
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
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-level3">{label}</dt>
          <dd className="num text-right text-level1">{value}</dd>
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
          className={`border-l-2 pl-2 ${blocksDeposit(issue) ? 'border-warn text-level1' : 'border-level3 text-level2'}`}
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
    <div role="alert" data-deposit-error={failure.kind} className="border-l-2 border-warn pl-2 text-level2">
      <p className="text-level1">
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

const stageText = (status: DepositStatus, chain: string, destination: string): string => {
  switch (status.stage) {
    case 'confirming':
      return `Waiting for ${chain} to confirm`
    case 'reverted':
      return `Reverted on ${chain}. The USDC stayed in the wallet`
    case 'replaced':
      return `The wallet replaced this transaction on ${chain}. Nothing was deposited`
    case 'relaying':
    case 'unwatched':
      return status.detail
    case 'unresolved':
      return `Check manually. ${status.detail}`
    case 'credited':
      return `Credited to ${destination} at ${clock(status.at)}`
  }
}

function Receipt({ account, venue, record }: { account: AccountRef; venue: DepositVenue; record: DepositRecord }) {
  const { status, late } = useDepositStatus(account, record)
  const route = depositRoutes(account).find((candidate) => candidate.chainId === record.chainId)
  const chain = chainName(record.chainId)
  const credited = status.stage === 'credited' ? status : null
  const failed = status.stage === 'reverted' || status.stage === 'replaced'
  const ended = credited !== null || failed || status.stage === 'unresolved'
  const kept = credited ? record.amount - credited.amount : null
  const rows: [string, React.ReactNode][] = [
    ['Sent', `${usdc(record.amount)} USDC from ${chain} at ${clock(record.sentAt)}`],
    ['Transaction', <TxLink key="tx" chainId={record.chainId} hash={sentHash(record)} />],
    ['Gas paid', record.gasPaid !== null ? gasText(record.gasPaid, record.chainId) : '…'],
    ['Fee', chargesText(kept === null ? record.fee : { expected: kept, max: kept }, record.message, record.chainId)],
    ['Credited', credited ? `${usdc(credited.amount)} USDC` : '…'],
    ...(credited ? [['Venue record', shortAddress(credited.receipt)] as [string, string]] : []),
  ]
  return (
    <section aria-label="Deposit receipt" data-deposit-stage={status.stage} className="flex flex-col gap-2">
      <p
        role={failed || status.stage === 'unresolved' ? 'alert' : 'status'}
        className={failed ? 'border-l-2 border-warn pl-2 text-level1' : 'text-level1'}
      >
        {stageText(status, chain, venue.destination)}
      </p>
      {status.stage === 'unresolved' && <CheckManually check={status.check} hash={sentHash(record)} />}
      {late && route && !ended && (
        <p role="alert" data-deposit-late className="border-l-2 border-warn pl-2 text-level2">
          Not credited after {minutes(route.eta.worst)} min, longer than this route takes.{' '}
          {status.stage === 'confirming'
            ? `${chain} has not confirmed the transaction yet. Check it in the explorer before sending again.`
            : `${chain} confirmed it, so the USDC left the wallet. Keep this receipt: the transaction hash is what the venue's support needs.`}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-level3">{label}</dt>
            <dd className="num text-right text-level1">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function CheckManually({ check, hash }: { check: { label: string; url: string }; hash: string }) {
  return (
    <div className="border-l-2 border-warn pl-2 text-level2">
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
        {deposits.slice(0, 5).map((deposit) => (
          <RecentRow
            key={deposit.hash}
            account={account}
            record={deposit}
            current={deposit.hash === shown}
            onShow={onShow}
          />
        ))}
      </ul>
    </section>
  )
}

const recentLabel = (status: DepositStatus, late: boolean): string => {
  switch (status.stage) {
    case 'credited':
      return 'Credited'
    case 'reverted':
      return 'Reverted'
    case 'replaced':
      return 'Replaced'
    case 'unresolved':
      return 'Check manually'
    case 'confirming':
    case 'relaying':
    case 'unwatched':
      return late ? 'Late' : 'In progress'
  }
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
        <span>{recentLabel(status, late)}</span>
      </Button>
    </li>
  )
}
