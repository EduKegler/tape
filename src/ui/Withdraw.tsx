import { useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { formatUnits } from 'viem'
import { USDC_DECIMALS, parseUsdc } from '@tape/trade/deposit'
import type { AccountRef, Decimal, TradeError } from '@tape/trade/types'
import { usdcFloor, withdrawIssues } from '@tape/trade/withdraw'
import type { SentWithdrawal, WithdrawIssue, WithdrawVenue } from '@tape/trade/withdraw'
import { useWithdraw, useWithdrawProgress, withdrawVenue } from '#/trade/withdraw'
import { wagmiConfig } from '#/wallet/config'
import { ErrorMark } from './ErrorMark'
import { shortAddress } from './format'
import { Button, Dialog, Input, TextLink } from './primitives'

const usdc = (units: bigint) => formatUnits(units, USDC_DECIMALS)
const chainName = (id: number) => wagmiConfig.chains.find((chain) => chain.id === id)?.name ?? `chain ${id}`
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB')

export function WithdrawButton({ account, available }: { account: AccountRef; available: Decimal }) {
  const venue = withdrawVenue(account)
  return venue ? <Withdraw account={account} venue={venue} available={usdcFloor(available)} /> : null
}

type Send = ReturnType<typeof useWithdraw>

function Withdraw({ account, venue, available }: { account: AccountRef; venue: WithdrawVenue; available: bigint }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const withdraw = useWithdraw(account)
  const amountRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button look="secondary" size="sm" onClick={() => setOpen(true)}>
        Withdraw
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Withdraw USDC from ${venue.source}`}
        initialFocus={amountRef}
        lockReason={withdraw.pending ? 'Confirm in your wallet. Esc stays here until you answer it.' : null}
      >
        {withdraw.sent ? (
          <>
            <Receipt account={account} venue={venue} sent={withdraw.sent} />
            <Button look="quiet" onClick={withdraw.reset} className="self-start">
              New withdrawal
            </Button>
          </>
        ) : (
          <WithdrawForm
            account={account}
            venue={venue}
            available={available}
            text={text}
            setText={setText}
            withdraw={withdraw}
            amountRef={amountRef}
          />
        )}
      </Dialog>
    </>
  )
}

function WithdrawForm({
  account,
  venue,
  available,
  text,
  setText,
  withdraw,
  amountRef,
}: {
  account: AccountRef
  venue: WithdrawVenue
  available: bigint
  text: string
  setText: (text: string) => void
  withdraw: Send
  amountRef: RefObject<HTMLInputElement | null>
}) {
  const amount = parseUsdc(text)
  const issues = amount ? withdrawIssues(venue, amount, available) : []
  const chain = chainName(venue.chainId[account.network])
  const unknown = withdraw.error?.kind === 'unknown-outcome'
  const edit = (next: string) => {
    if (!unknown) withdraw.reset()
    setText(next)
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (amount && issues.length === 0) withdraw.send(amount)
      }}
    >
      <Input
        inputRef={amountRef}
        label="Amount (USDC)"
        name="amount"
        value={text}
        disabled={withdraw.pending}
        error={text !== '' && amount === null ? 'A positive amount, at most 6 decimals.' : undefined}
        hint={
          <Button look="quiet" disabled={withdraw.pending} onClick={() => edit(usdc(available))}>
            Max {usdc(available)}
          </Button>
        }
        onChange={edit}
      />
      <dl aria-label="Withdrawal summary" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {(
          [
            ['Route', [venue.source, ...venue.hops, chain].join(' → ')],
            [
              'Sent to',
              <span key="to">
                <span className="num">{shortAddress(account.owner)}</span>, the same address
              </span>,
            ],
            ['Fee', `${usdc(venue.fee)} USDC`],
            ['You receive', amount && amount > venue.fee ? `${usdc(amount - venue.fee)} USDC` : '…'],
            ['Time', `About ${minutes(venue.eta)} min`],
            ['Wallet asks', 'One signature, no gas'],
          ] satisfies [string, ReactNode][]
        ).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-level3">{label}</dt>
            <dd className="text-right text-level1 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li key={issue.kind} className="flex gap-1.5 text-level1">
              <ErrorMark />
              <span role="alert">{issueText(issue, venue)}</span>
            </li>
          ))}
        </ul>
      )}
      <Button look="primary" size="lg" type="submit" disabled={!amount || issues.length > 0 || withdraw.pending}>
        {withdraw.pending
          ? 'Waiting for your wallet…'
          : amount
            ? `${unknown ? 'Withdraw again' : 'Withdraw'} ${usdc(amount)} USDC to ${chain}`
            : 'Withdraw'}
      </Button>
      <SendError account={account} venue={venue} error={withdraw.error} />
    </form>
  )
}

function issueText(issue: WithdrawIssue, venue: WithdrawVenue): string {
  switch (issue.kind) {
    case 'not-above-fee':
      return `The fee is ${usdc(issue.fee)} USDC. Withdraw more than that.`
    case 'over-available':
      return `${venue.source} has ${usdc(issue.available)} USDC free to withdraw.`
  }
}

function SendError({ account, venue, error }: { account: AccountRef; venue: WithdrawVenue; error: TradeError | null }) {
  if (!error) return null
  if (error.kind === 'unknown-outcome') {
    const check = venue.check(account)
    return (
      <div role="alert" data-withdraw-error={error.kind} className="border-l-2 border-warn pl-2 text-level2">
        No answer came back, so the withdrawal may have gone through. Open the{' '}
        <TextLink href={check.url} newTab>
          {check.label}
        </TextLink>{' '}
        before you withdraw again.
      </div>
    )
  }
  const detail = 'detail' in error ? error.detail : null
  return (
    <div role="alert" data-withdraw-error={error.kind} className="flex gap-1.5 text-level1">
      <ErrorMark />
      <div className="min-w-0">
        <p>{sendErrorText(error, venue)}</p>
        {detail && <p className="mt-0.5 text-xs break-all text-level3">{detail}</p>}
      </div>
    </div>
  )
}

function sendErrorText(error: TradeError, venue: WithdrawVenue): string {
  switch (error.kind) {
    case 'wallet-rejected':
      return 'You declined in the wallet. Nothing was sent.'
    case 'unreachable':
      return `Could not reach ${venue.source}. Nothing was sent.`
    case 'unexpected':
      return 'Something went wrong in Tape. Nothing was sent.'
    case 'unknown-outcome':
      return 'No answer came back, so the withdrawal may have gone through.'
    case 'needs-setup':
    case 'no-account':
    case 'insufficient-margin':
    case 'invalid-order':
    case 'rejected':
    case 'rate-limited':
    case 'unsupported':
      return `${venue.source} refused the withdrawal. The USDC stayed in the account.`
  }
}

function Receipt({ account, venue, sent }: { account: AccountRef; venue: WithdrawVenue; sent: SentWithdrawal }) {
  const progress = useWithdrawProgress(account, sent)
  const check = venue.check(account)
  const chain = chainName(venue.chainId[account.network])
  const to = <span className="num">{shortAddress(account.owner)}</span>
  return (
    <section
      aria-label="Withdrawal receipt"
      data-withdraw-stage={progress?.stage ?? 'pending'}
      className="flex flex-col gap-2"
    >
      <p role="status" className="text-level1">
        {progress?.stage === 'finalized' ? (
          <>
            {venue.source} sent {usdc(progress.received)} USDC to {to} on {chain} at {clock(progress.at)}.
          </>
        ) : (
          <>
            {venue.source} took the withdrawal at {clock(sent.nonce)}. {usdc(sent.amount - venue.fee)} USDC goes to {to}{' '}
            on {chain} in about {minutes(venue.eta)} min.
          </>
        )}
      </p>
      <p className="text-level2">
        Follow it in the{' '}
        <TextLink href={check.url} newTab>
          {check.label}
        </TextLink>
        .
      </p>
    </section>
  )
}
