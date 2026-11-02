import { useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { formatUnits } from 'viem'
import { USDC_DECIMALS, parseUsdc } from '@tape/trade/deposit'
import type { AccountRef, Decimal, TradeError } from '@tape/trade/types'
import { usdcFloor, withdrawIssues } from '@tape/trade/withdraw'
import type { SentWithdrawal, WithdrawIssue, WithdrawProgress, WithdrawVenue } from '@tape/trade/withdraw'
import { useWithdraw, useWithdrawProgress, withdrawVenue } from '#/trade/withdraw'
import { wagmiConfig } from '#/wallet/config'
import { ErrorMark } from './ErrorMark'
import { shortAddress } from './format'
import { useNow } from './now'
import { Button, Dialog, Input, TextLink } from './primitives'

const usdc = (units: bigint) => formatUnits(units, USDC_DECIMALS)
const chainName = (id: number) => wagmiConfig.chains.find((chain) => chain.id === id)?.name ?? `chain ${id}`
const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB')
const countdown = (ms: number) => {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function WithdrawButton({ account, available }: { account: AccountRef; available: Decimal }) {
  const venue = withdrawVenue(account)
  return venue ? <Withdraw account={account} venue={venue} available={usdcFloor(available)} /> : null
}

type Send = ReturnType<typeof useWithdraw>

interface SlipState {
  readonly amount: bigint | null
  readonly before: bigint
  readonly pending: boolean
  readonly error: TradeError | null
  readonly sent: SentWithdrawal | null
  readonly progress: WithdrawProgress | null
}

function Withdraw({ account, venue, available }: { account: AccountRef; venue: WithdrawVenue; available: bigint }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [before, setBefore] = useState(available)
  const withdraw = useWithdraw(account)
  const progress = useWithdrawProgress(account, withdraw.sent)
  const amountRef = useRef<HTMLInputElement>(null)
  const finalized = progress?.stage === 'finalized'
  const startOver = () => {
    withdraw.reset()
    setText('')
  }
  const close = () => {
    setOpen(false)
    if (finalized) startOver()
  }
  const send = (amount: bigint) => {
    setBefore(available)
    withdraw.send(amount)
  }
  const draft = parseUsdc(text)
  const slip: SlipState = {
    amount: withdraw.sent
      ? withdraw.sent.amount
      : draft && withdrawIssues(venue, draft, available).length === 0
        ? draft
        : null,
    before: withdraw.sent || withdraw.pending ? before : available,
    pending: withdraw.pending,
    error: withdraw.error,
    sent: withdraw.sent,
    progress,
  }
  return (
    <>
      {withdraw.sent && !open && (
        <Trail venue={venue} sent={withdraw.sent} progress={progress} onOpen={() => setOpen(true)} />
      )}
      <Button look="secondary" size="sm" onClick={() => setOpen(true)}>
        Withdraw
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={`Withdraw USDC from ${venue.source}`}
        width={withdraw.sent ? 'slip' : 'split'}
        initialFocus={amountRef}
        lockReason={withdraw.pending ? 'Confirm in your wallet. Esc stays here until you answer it.' : null}
      >
        {withdraw.sent ? (
          <>
            <div className="overflow-hidden rounded-md bg-inset px-3 pt-5">
              <Slip account={account} venue={venue} state={slip} />
            </div>
            <p className="text-level3">
              {finalized
                ? 'This slip is your receipt.'
                : 'You can close this. The withdrawal keeps going, and its slip waits in Account until the USDC lands.'}
            </p>
            <div className="flex gap-2">
              <Button look="secondary-raised" size="lg" className="flex-1" onClick={close}>
                Close
              </Button>
              {finalized && (
                <Button look="primary" size="lg" className="flex-1" onClick={startOver}>
                  New withdrawal
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_22rem] gap-4">
            <WithdrawForm
              account={account}
              venue={venue}
              available={available}
              text={text}
              setText={setText}
              withdraw={withdraw}
              send={send}
              amountRef={amountRef}
            />
            <div className="flex flex-col justify-end overflow-hidden rounded-md bg-inset px-3 pt-5">
              <Slip account={account} venue={venue} state={slip} />
            </div>
          </div>
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
  send,
  amountRef,
}: {
  account: AccountRef
  venue: WithdrawVenue
  available: bigint
  text: string
  setText: (text: string) => void
  withdraw: Send
  send: (amount: bigint) => void
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
      className="flex min-h-80 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (amount && issues.length === 0) send(amount)
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
      <p className="mt-auto text-level3">
        Your wallet asks for one signature, with no gas. The USDC goes to the address connected to Tape.
      </p>
      <Button look="primary" size="lg" type="submit" disabled={!amount || issues.length > 0 || withdraw.pending}>
        {withdraw.pending
          ? 'Waiting for your wallet…'
          : amount
            ? `${unknown ? 'Withdraw again' : 'Withdraw'} ${usdc(amount)} USDC to ${chain}`
            : 'Withdraw'}
      </Button>
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

function Slip({ account, venue, state }: { account: AccountRef; venue: WithdrawVenue; state: SlipState }) {
  const chain = chainName(venue.chainId[account.network])
  const { amount, before } = state
  const lines = stamps(account, venue, state)
  const rows: [string, ReactNode, string?][] = [
    ['From', venue.source],
    ['Via', venue.hops.join(', ')],
    [
      'To',
      <span key="to">
        <span className="num">{shortAddress(account.owner)}</span>{' '}
        <span className="text-xs text-level3">on {chain}</span>
      </span>,
    ],
    ['Amount', amount ? usdc(amount) : '—', 'num'],
    ['Fee', amount ? `−${usdc(venue.fee)}` : '—', 'num'],
    ['You receive', amount ? `${usdc(amount - venue.fee)} USDC` : '—', 'num'],
    ['Available before', usdc(before), 'num text-level3'],
    ['Available after', amount ? usdc(before - amount) : '—', 'num'],
    ['Arrives', `About ${minutes(venue.eta)} min`],
  ]
  return (
    <section
      key={lines.length}
      aria-label="Withdrawal slip"
      data-withdraw-stage={state.progress?.stage ?? (state.sent ? 'pending' : 'draft')}
      className={`relative bg-surface px-3 pt-3 pb-4 text-sm text-level2 tabular-nums motion-safe:animate-slip-feed ${state.progress?.stage === 'finalized' ? 'wash' : ''}`}
    >
      <TornEdge />
      <h3 className="flex items-baseline justify-between text-base font-semibold text-level1">
        Withdrawal
        <span className="num text-xs font-normal text-level3">
          {state.sent ? `#${state.sent.nonce % 1_000_000}` : 'draft'}
        </span>
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([label, value, className = ''], index) => (
          <div
            key={label}
            className={`col-span-2 grid grid-cols-subgrid ${index === 3 || index === 6 ? 'mt-1 border-t border-dashed border-edge/60 pt-2.5' : ''}`}
          >
            <dt className={label === 'You receive' ? 'font-medium text-level1' : 'text-level3'}>{label}</dt>
            <dd
              className={`text-right text-level1 ${label === 'You receive' ? 'text-base font-medium' : ''} ${className}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {lines.length > 0 && (
        <ol aria-label="Answers" className="mt-3 flex flex-col gap-1.5">
          {lines.map(([key, line], index) => (
            <li
              key={key}
              className={`border-t border-rule pt-1.5 text-level1 ${index === lines.length - 1 ? 'motion-safe:animate-print' : ''}`}
            >
              {line}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function TornEdge() {
  const id = useId()
  return (
    <svg aria-hidden="true" className="absolute inset-x-0 -top-1.5 h-1.5 w-full">
      <defs>
        <pattern id={id} width="10" height="6" patternUnits="userSpaceOnUse">
          <rect width="10" height="6" className="fill-surface" />
          <circle cx="5" cy="0" r="3.5" className="fill-inset" />
        </pattern>
      </defs>
      <rect width="100%" height="6" fill={`url(#${id})`} />
    </svg>
  )
}

function stamps(account: AccountRef, venue: WithdrawVenue, state: SlipState): [string, ReactNode][] {
  const chain = chainName(venue.chainId[account.network])
  const check = venue.check(account)
  const link = (
    <TextLink href={check.url} newTab>
      {check.label}
    </TextLink>
  )
  const lines: [string, ReactNode][] = []
  if (state.pending)
    lines.push([
      'wallet',
      <Stamp key="wallet" label="Waiting for your signature">
        <span aria-hidden="true" className="inline-block h-2.5 w-1.5 bg-accent motion-safe:animate-caret" />
      </Stamp>,
    ])
  if (state.error) lines.push(['error', <SendError key="error" venue={venue} error={state.error} link={link} />])
  if (state.sent) {
    lines.push(['taken', <Stamp key="taken" label={`Taken by ${venue.source}`} value={clock(state.sent.nonce)} />])
    if (state.progress?.stage === 'finalized') {
      lines.push([
        'sent',
        <span key="sent" role="status" className="contents">
          <Stamp label={`Sent ${usdc(state.progress.received)} USDC on ${chain}`} value={clock(state.progress.at)} />
        </span>,
      ])
      lines.push(['check', link])
    } else {
      lines.push(['arrival', <Arrival key="arrival" sent={state.sent} venue={venue} chain={chain} />])
    }
  }
  return lines
}

function Stamp({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      {value && <span className="num text-level2">{value}</span>}
      {children}
    </span>
  )
}

function Arrival({ sent, venue, chain }: { sent: SentWithdrawal; venue: WithdrawVenue; chain: string }) {
  const now = useNow(true)
  const left = sent.nonce + venue.eta * 1000 - now
  return (
    <span role="status" className="flex flex-col gap-0.5">
      {left > 0 ? (
        <Stamp label="Arrives in" value={countdown(left)} />
      ) : (
        <Stamp label="Due now, waiting for the ledger" />
      )}
      <span className="text-xs text-level3">The bridge signs it, then it pays out on {chain}.</span>
    </span>
  )
}

function SendError({ venue, error, link }: { venue: WithdrawVenue; error: TradeError; link: ReactNode }) {
  if (error.kind === 'unknown-outcome') {
    return (
      <span role="alert" data-withdraw-error={error.kind} className="flex flex-col gap-0.5">
        <span className="text-warn">No answer came back. It may have gone through.</span>
        <span className="text-xs text-level3">Open the {link} before you withdraw again.</span>
      </span>
    )
  }
  if (error.kind === 'wallet-rejected') {
    return (
      <span role="alert" data-withdraw-error={error.kind} className="flex flex-col gap-0.5">
        Declined in the wallet
        <span className="text-xs text-level3">Nothing was sent.</span>
      </span>
    )
  }
  const detail = 'detail' in error ? error.detail : null
  return (
    <span role="alert" data-withdraw-error={error.kind} className="flex gap-1.5">
      <ErrorMark />
      <span className="min-w-0">
        {sendErrorText(error, venue)}
        {detail && <span className="mt-0.5 block text-xs break-all text-level3">“{detail}”</span>}
      </span>
    </span>
  )
}

function sendErrorText(error: TradeError, venue: WithdrawVenue): string {
  switch (error.kind) {
    case 'wallet-rejected':
      return 'You declined in the wallet. Nothing was sent.'
    case 'nondeterministic-wallet':
      return 'Your wallet signed the same request two different ways. Nothing was sent.'
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
      return `${venue.source} refused it. The USDC stayed in the account.`
  }
}

function Trail({
  venue,
  sent,
  progress,
  onOpen,
}: {
  venue: WithdrawVenue
  sent: SentWithdrawal
  progress: WithdrawProgress | null
  onOpen: () => void
}) {
  const finalized = progress?.stage === 'finalized'
  const now = useNow(!finalized)
  const left = sent.nonce + venue.eta * 1000 - now
  return (
    <Button
      look="secondary"
      size="sm"
      onClick={onOpen}
      className={`flex items-center gap-2 ${finalized ? 'wash' : ''}`}
    >
      {finalized ? `Sent ${usdc(progress.received)} USDC` : `Withdrawing ${usdc(sent.amount)} USDC`}
      {!finalized && <span className="num text-level2">{left > 0 ? countdown(left) : 'due'}</span>}
    </Button>
  )
}
