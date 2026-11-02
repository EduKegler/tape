import { createContext, use, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useConnect, useConnection, useConnectors } from 'wagmi'
import type { Connector, CreateConnectorFn } from 'wagmi'
import { track } from '#/analytics/track'
import { ErrorMark } from '#/ui/ErrorMark'
import { shortAddress } from '#/ui/format'
import { Button, Popover, TextLink } from '#/ui/primitives'
import { TapeMark } from '#/ui/TapeMark'
import { INJECTED_ID, browserWallets, connectFailure, waitClock } from './flow'
import type { ConnectFailure } from './flow'
import { fade, flip, morph, nextFrame, play, reducedMotion, rise, sleep } from './motion'
import { PairingQr } from './PairingQr'
import { useWalletSettled } from './settled'

export type Landing = 'idle' | 'holding' | 'landing' | 'landed'

interface Flow {
  readonly openerId: string | null
  readonly landing: Landing
  readonly open: (openerId: string, opener: HTMLElement) => void
  readonly anchor: (element: HTMLElement | null) => void
  readonly chip: (element: HTMLButtonElement | null) => void
}

const FlowContext = createContext<Flow | null>(null)

export function useConnectFlow(): Flow {
  const flow = use(FlowContext)
  if (!flow) throw new Error('useConnectFlow needs a ConnectProvider')
  return flow
}

type Phase = 'waiting' | 'filling' | 'connected'

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'qr'; readonly connector: Connector }
  | {
      readonly kind: 'handshake'
      readonly connector: Connector
      readonly phase: Phase
      readonly since: number
      readonly address: string | null
    }
  | { readonly kind: 'rejected'; readonly connector: Connector; readonly failure: ConnectFailure }

type Entry =
  | { readonly kind: 'open'; readonly from: DOMRect }
  | { readonly kind: 'swap'; readonly before: number; readonly tile: DOMRect | null; readonly to: View['kind'] }

const HOLES = Array.from({ length: 16 }, (_, index) => index)
const FILL_MS = (HOLES.length - 1) * 18 + 120
const CONNECTED_HOLD_MS = 460
const WASH_MS = 900

const kindOf = (connector: Connector | CreateConnectorFn) =>
  'type' in connector && (connector.type === 'injected' || connector.type === 'walletConnect')
    ? connector.type
    : 'other'

const handshake = (connector: Connector, phase: Phase): View => ({
  kind: 'handshake',
  connector,
  phase,
  since: Date.now(),
  address: null,
})

const isPhone = (connector: Connector) => connector.type === 'walletConnect'

const walletName = (connector: Connector) => (connector.id === INJECTED_ID ? 'Browser wallet' : connector.name)

function useWallets() {
  const connectors = useConnectors()
  const injected = connectors.find((connector) => connector.id === INJECTED_ID)
  const [present, setPresent] = useState(false)
  useEffect(() => {
    let live = true
    void injected?.getProvider().then(
      (provider) => live && setPresent(Boolean(provider)),
      () => live && setPresent(false),
    )
    return () => {
      live = false
    }
  }, [injected])
  return {
    browser: browserWallets(connectors, present),
    phone: connectors.find((connector) => connector.type === 'walletConnect') ?? null,
  }
}

export function ConnectProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [openerId, setOpenerId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [landing, setLanding] = useState<Landing>('idle')
  const [view, setView] = useState<View>({ kind: 'list' })
  const current = useRef<View>(view)
  const opener = useRef<HTMLElement | null>(null)
  const chip = useRef<HTMLButtonElement | null>(null)
  const layer = useRef<HTMLDivElement | null>(null)
  const backdrop = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const entry = useRef<Entry | null>(null)
  const queue = useRef(Promise.resolve())
  const attempt = useRef(0)
  const busy = useRef(false)
  const wallets = useWallets()
  const { isConnected } = useConnection()
  const { mutate: connect, reset } = useConnect({
    mutation: {
      onSuccess: (_data, { connector }) => track({ event: 'wallet_connected', connector: kindOf(connector) }),
      onError: (failure, { connector }) =>
        track({ event: 'wallet_connect_failed', connector: kindOf(connector), reason: connectFailure(failure).kind }),
    },
  })

  const show = (next: View) => {
    current.current = next
    setView(next)
  }

  const go = (next: View) => {
    queue.current = queue.current.then(async () => {
      const from = current.current
      const root = body.current
      const before = layer.current?.offsetHeight ?? 0
      const chosen =
        from.kind === 'list' && 'connector' in next
          ? (root?.querySelector(`[data-wallet="${next.connector.uid}"]`) ?? null)
          : null
      const tile = chosen?.querySelector('[data-tile]')?.getBoundingClientRect() ?? null
      if (from.kind === 'list' && root && !reducedMotion())
        await Promise.all(
          [...root.querySelectorAll('[data-leave]')]
            .filter((element) => element !== chosen)
            .map((element, index) =>
              play(element, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(-6px)' }], {
                duration: 120,
                delay: index * 12,
                easing: 'ease-in',
              }),
            ),
        )
      entry.current = { kind: 'swap', before, tile, to: next.kind }
      show(next)
    })
    return queue.current
  }

  const settle = () => {
    entry.current = null
    attempt.current++
    reset()
  }

  const choose = (connector: Connector) => {
    if (busy.current) return
    const id = ++attempt.current
    setLanding('holding')
    void go(isPhone(connector) ? { kind: 'qr', connector } : handshake(connector, 'waiting'))
    connect(
      { connector },
      {
        onSuccess: ({ accounts }) => {
          if (attempt.current === id) void land(connector, accounts[0])
        },
        onError: (error) => {
          if (attempt.current !== id) return
          setLanding('idle')
          void go({ kind: 'rejected', connector, failure: connectFailure(error) })
        },
      },
    )
  }

  const back = () => {
    if (busy.current) return
    settle()
    setLanding('idle')
    void go({ kind: 'list' })
  }

  const land = async (connector: Connector, address: string) => {
    busy.current = true
    await queue.current
    const reduced = reducedMotion()
    const was = current.current
    if (was.kind === 'handshake') show({ ...was, phase: 'filling' })
    else await go(handshake(connector, 'filling'))
    await sleep(reduced ? 0 : FILL_MS)
    const filled = current.current
    if (filled.kind === 'handshake') show({ ...filled, phase: 'connected', address })
    await sleep(CONNECTED_HOLD_MS)
    setLanding('landing')
    await nextFrame()
    await nextFrame()
    const target = chip.current?.getBoundingClientRect()
    const own = layer.current?.getBoundingClientRect()
    void fade(backdrop.current, 0, reduced ? 120 : 260)
    if (!reduced && target && own) {
      void fade(body.current, 0, 110)
      await morph(layer.current, target, own, { duration: 420, back: true })
    } else await fade(layer.current?.parentElement ?? null, 0, 120)
    setOpen(false)
    setOpenerId(null)
    setLanding('landed')
    busy.current = false
    await sleep(WASH_MS + 400)
    setLanding((now) => (now === 'landed' ? 'idle' : now))
  }

  const close = async () => {
    if (busy.current || !open) return
    busy.current = true
    settle()
    setLanding('idle')
    const reduced = reducedMotion()
    const source = opener.current?.isConnected ? opener.current.getBoundingClientRect() : null
    const own = layer.current?.getBoundingClientRect()
    void fade(backdrop.current, 0, reduced ? 100 : 220)
    if (!reduced && source && source.width > 0 && own) {
      void fade(body.current, 0, 90)
      await morph(layer.current, source, own, { duration: 300, back: true, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })
    } else await fade(layer.current?.parentElement ?? null, 0, 100)
    setOpen(false)
    setOpenerId(null)
    busy.current = false
  }

  const enter = (retry = true) => {
    const root = body.current
    // React attaches the Popover's refs after the panel's layout effect on mount, so the open reads them a microtask later.
    if (!root && retry) {
      queueMicrotask(() => enter(false))
      return
    }
    const pending = entry.current
    entry.current = null
    if (!pending || !root) return
    const reduced = reducedMotion()
    if (pending.kind === 'open') {
      if (reduced) {
        void fade(backdrop.current, 1, 120)
        void fade(layer.current?.parentElement ?? null, 1, 140)
        return
      }
      void fade(backdrop.current, 1, 240)
      void rise(root.querySelectorAll('[data-stagger]'), { from: 90, step: 28 })
      const own = layer.current?.getBoundingClientRect()
      if (own) void morph(layer.current, pending.from, own, { duration: 440 })
      return
    }
    root.querySelector<HTMLElement>('[data-focus]')?.focus({ preventScroll: true })
    if (reduced) {
      void fade(root, 1, 140)
      return
    }
    const after = layer.current?.offsetHeight ?? 0
    if (after > 0 && pending.before > 0)
      void play(layer.current, [{ transform: `scaleY(${pending.before / after})` }, { transform: 'none' }], {
        duration: 320,
      })
    if (pending.to === 'list') {
      void rise(root.querySelectorAll('[data-stagger]'), { from: 90, step: 28 })
      return
    }
    const node = root.querySelector('[data-node="wallet"]')
    if (pending.tile && node) {
      void flip(node, pending.tile, { duration: 460 })
      void play(
        root.querySelector('[data-node="tape"]'),
        [
          { opacity: 0, transform: 'scale(0.7)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: 300,
          delay: 120,
        },
      )
      void play(root.querySelector('[data-line]'), [{ transform: 'scaleX(0)' }, { transform: 'none' }], {
        duration: 360,
        delay: 160,
      })
      void rise(root.querySelectorAll('[data-rise]'), { from: 200, step: 40, rise: 4 })
      return
    }
    if (pending.to === 'rejected') {
      void play(root.querySelector('[role="alert"]'), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80 })
      return
    }
    void fade(root, 1, 160)
  }

  useEffect(() => {
    if (open && isConnected && landing === 'idle') void close()
  })

  const flow: Flow = {
    openerId,
    landing,
    chip: (element) => {
      chip.current = element
    },
    anchor: setAnchor,
    open: (id, element) => {
      if (open || busy.current) return
      opener.current = element
      entry.current = { kind: 'open', from: element.getBoundingClientRect() }
      show({ kind: 'list' })
      setOpenerId(id)
      setOpen(true)
    },
  }

  return (
    <FlowContext value={flow}>
      {children}
      <Popover
        open={open}
        onClose={() => void close()}
        anchor={anchor}
        title={view.kind === 'qr' ? 'Scan with your phone' : 'Connect a wallet'}
        layerRef={layer}
        backdropRef={backdrop}
        bodyRef={body}
        initialFocus={() => body.current?.querySelector<HTMLElement>('[data-focus]') ?? null}
        finalFocus={() => chip.current ?? (opener.current?.isConnected ? opener.current : null)}
      >
        <Panel view={view} wallets={wallets} onEnter={() => enter()} onChoose={choose} onBack={back} />
      </Popover>
    </FlowContext>
  )
}

function Panel({
  view,
  wallets,
  onEnter,
  onChoose,
  onBack,
}: {
  view: View
  wallets: ReturnType<typeof useWallets>
  onEnter: () => void
  onChoose: (connector: Connector) => void
  onBack: () => void
}) {
  const enter = useEffectEvent(onEnter)
  useLayoutEffect(() => enter(), [view.kind])
  switch (view.kind) {
    case 'list':
      return <WalletList wallets={wallets} onChoose={onChoose} />
    case 'qr':
      return <PairingQr connector={view.connector} onBack={onBack} />
    case 'handshake':
      return <Waiting view={view} onCancel={onBack} />
    case 'rejected':
      return (
        <Rejected
          connector={view.connector}
          failure={view.failure}
          onOther={onBack}
          onRetry={() => onChoose(view.connector)}
        />
      )
  }
}

function WalletList({
  wallets,
  onChoose,
}: {
  wallets: ReturnType<typeof useWallets>
  onChoose: (connector: Connector) => void
}) {
  return (
    <>
      <GroupLabel>In this browser</GroupLabel>
      <div className="mb-4 flex flex-col gap-1.5">
        {wallets.browser.length > 0 ? (
          wallets.browser.map((connector, index) => (
            <WalletRow
              key={connector.uid}
              connector={connector}
              tag="Detected"
              focus={index === 0}
              onChoose={onChoose}
            />
          ))
        ) : (
          <div data-stagger data-leave className="rounded-lg bg-option p-3">
            <p className="text-base font-semibold text-level1">No wallet in this browser</p>
            <p className="mt-1 text-level2">
              Install{' '}
              <TextLink href="https://rabby.io" newTab>
                Rabby
              </TextLink>{' '}
              or{' '}
              <TextLink href="https://metamask.io" newTab>
                MetaMask
              </TextLink>{' '}
              and reload
              {wallets.phone ? ', or pair a phone wallet.' : '.'}
            </p>
          </div>
        )}
      </div>
      {wallets.phone && (
        <>
          <GroupLabel>On your phone</GroupLabel>
          <div className="mb-4">
            <WalletRow
              connector={wallets.phone}
              detail="Scan a QR code"
              focus={wallets.browser.length === 0}
              onChoose={onChoose}
            />
          </div>
        </>
      )}
      <p data-stagger data-leave className="text-xs text-level3">
        Signed in to Hyperliquid with email? Export it from Hyperliquid&apos;s settings with{' '}
        <TextLink href="https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/export-your-email-wallet" newTab>
          Export Email Wallet
        </TextLink>
        , import it into your wallet, then connect here.
      </p>
      <p data-stagger data-leave className="mt-5 border-t border-rule pt-4 text-xs text-level3">
        Connecting shares your address. Nothing is signed until you enable trading on a venue.
      </p>
    </>
  )
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p data-stagger data-leave className="mb-2 ml-0.5 text-xs text-level3">
      {children}
    </p>
  )
}

function WalletRow({
  connector,
  tag,
  detail,
  focus,
  onChoose,
}: {
  connector: Connector
  tag?: string
  detail?: string
  focus: boolean
  onChoose: (connector: Connector) => void
}) {
  return (
    <Button
      look="option"
      data-wallet={connector.uid}
      data-stagger
      data-leave
      data-focus={focus || undefined}
      onClick={() => onChoose(connector)}
    >
      <WalletTile connector={connector} className="size-10 rounded-md" />
      <span className="flex-1 text-base font-semibold text-level1">
        {walletName(connector)}
        {detail && <span className="block text-xs font-normal text-level2">{detail}</span>}
      </span>
      {tag && (
        <span className="flex items-center gap-1.5 text-xs text-level2 before:size-1.5 before:bg-level2">{tag}</span>
      )}
      <svg
        aria-hidden
        viewBox="0 0 14 14"
        className="size-3.5 text-level3 group-hover:translate-x-1 group-hover:text-level1 motion-safe:transition-transform"
      >
        <path d="M3 7h8m-3-3 3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </Button>
  )
}

function WalletTile({ connector, className }: { connector: Connector; className: string }) {
  if (connector.icon) return <img data-tile src={connector.icon} alt="" className={`shrink-0 ${className}`} />
  if (isPhone(connector))
    return (
      <svg data-tile aria-hidden viewBox="0 0 28 28" className={`shrink-0 ${className}`}>
        <rect width="28" height="28" fill="#3b99fc" />
        <path
          fill="#fff"
          d="M9.2 11.6c2.7-2.6 7-2.6 9.6 0l.3.3c.1.1.1.4 0 .5l-1.1 1c-.1.1-.2.1-.2 0l-.4-.4c-1.9-1.8-4.9-1.8-6.8 0l-.5.4c-.1.1-.2.1-.2 0l-1.1-1c-.1-.1-.1-.4 0-.5l.4-.3Zm11.9 2.2 1 1c.1.1.1.4 0 .5l-4.4 4.3c-.1.1-.4.1-.5 0l-3.1-3.1h-.1l-3.1 3.1c-.1.1-.4.1-.5 0L6 15.3c-.1-.1-.1-.4 0-.5l1-1c.1-.1.4-.1.5 0l3.1 3.1h.1l3.1-3.1c.1-.1.4-.1.5 0l3.1 3.1h.1l3.1-3.1c.1-.1.3-.1.5 0Z"
        />
      </svg>
    )
  return (
    <svg data-tile aria-hidden viewBox="0 0 28 28" className={`shrink-0 bg-surface text-level2 ${className}`}>
      <rect x="6" y="9" width="16" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 12h16M17 16h2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

type Line = Phase | 'rejected'

function holeLook(line: Line, index: number) {
  switch (line) {
    case 'waiting':
      return { className: 'bg-level3/15 motion-safe:animate-feed', delay: index * 60 }
    case 'filling':
    case 'connected':
      return { className: 'bg-accent motion-safe:animate-feed-fill', delay: index * 18 }
    case 'rejected':
      return { className: 'bg-err/25 motion-safe:animate-feed-unwind', delay: (HOLES.length - 1 - index) * 18 }
  }
}

function Handshake({ connector, line }: { connector: Connector; line: Line }) {
  return (
    <>
      <div className="grid grid-cols-[4rem_1fr_4rem] items-center gap-3 px-2 pt-5 pb-1">
        <div data-node="tape" className="grid size-16 place-items-center rounded-lg border border-rule bg-surface">
          <TapeMark className="size-7.5 text-level1" />
        </div>
        <div data-line aria-hidden className="relative flex h-1.5 items-center justify-between">
          {HOLES.map((index) => {
            const hole = holeLook(line, index)
            return (
              <span
                key={index}
                className={`size-1.5 ${hole.className}`}
                style={{ animationDelay: `${hole.delay}ms` }}
              />
            )
          })}
          {line === 'rejected' && (
            <span className="absolute top-1/2 left-1/2 grid -translate-1/2 bg-raised px-1.5 motion-safe:animate-pop">
              <ErrorMark className="size-3.5" />
            </span>
          )}
        </div>
        <div data-node="wallet" className="relative size-16 overflow-hidden rounded-lg">
          <WalletTile connector={connector} className="size-16" />
          {line === 'connected' && <span aria-hidden className="pointer-events-none absolute inset-0 wash" />}
        </div>
      </div>
      <div data-rise className="grid grid-cols-[4rem_1fr_4rem] gap-3 px-2 pt-2 text-center text-xs text-level3">
        <span>Tape</span>
        <span />
        <span className="flex justify-center whitespace-nowrap">
          {isPhone(connector) ? 'Phone' : walletName(connector)}
        </span>
      </div>
    </>
  )
}

function Waiting({ view, onCancel }: { view: Extract<View, { kind: 'handshake' }>; onCancel: () => void }) {
  const phone = isPhone(view.connector)
  const name = walletName(view.connector)
  return (
    <>
      <Handshake connector={view.connector} line={view.phase} />
      <div data-rise className="mt-5 text-center">
        {view.phase === 'connected' && view.address ? (
          <div role="status">
            <h3 className="text-lg font-semibold text-level1">Connected</h3>
            <p className="num mt-2.5 text-xl font-semibold text-level1">{shortAddress(view.address)}</p>
          </div>
        ) : (
          <>
            <div role="status">
              <h3 className="text-lg font-semibold text-level1">
                {phone ? 'Waiting for your phone' : `Waiting for ${name}`}
              </h3>
              <p className="mt-1.5 text-level2">
                {phone
                  ? 'Approve the connection in your phone wallet.'
                  : `Approve the connection in the ${name} popup.`}
              </p>
            </div>
            <WaitClock since={view.since} running={view.phase === 'waiting'} />
          </>
        )}
      </div>
      <div data-rise className="mt-5 flex gap-2">
        <Button look="secondary-raised" size="lg" className="flex-1" data-focus onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  )
}

function WaitClock({ since, running }: { since: number; running: boolean }) {
  const [now, setNow] = useState(since)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [running])
  return (
    <div role="timer" className="mt-4 grid justify-items-center gap-1.5">
      <span className="num text-xl font-semibold text-level1">{waitClock(now - since)}</span>
      <span className="text-xs text-level3">since the request</span>
    </div>
  )
}

function Rejected({
  connector,
  failure,
  onOther,
  onRetry,
}: {
  connector: Connector
  failure: ConnectFailure
  onOther: () => void
  onRetry: () => void
}) {
  const who = isPhone(connector) ? 'Your phone wallet' : walletName(connector)
  const message =
    failure.kind === 'rejected'
      ? `${who} said no. Nothing was shared.`
      : failure.kind === 'no-wallet'
        ? 'No wallet in this browser.'
        : failure.message
  return (
    <>
      <Handshake connector={connector} line="rejected" />
      <div role="alert" className="mt-5 text-center">
        <h3 className="text-lg font-semibold text-level1">
          {failure.kind === 'rejected' ? 'Connection rejected' : 'Connection failed'}
        </h3>
        <p className="mt-2 inline-flex items-start gap-2 text-left text-level1">
          <ErrorMark />
          {message}
        </p>
      </div>
      <div className="mt-5 flex gap-2">
        <Button look="secondary-raised" size="lg" className="flex-1" onClick={onOther}>
          Other wallet
        </Button>
        <Button look="primary" size="lg" className="flex-1" data-focus onClick={onRetry}>
          Try again
        </Button>
      </div>
    </>
  )
}

export function ConnectButton({ wide = false }: { wide?: boolean }) {
  const flow = useConnectFlow()
  const id = useId()
  const settled = useWalletSettled()
  const hidden = flow.openerId === id || !settled ? 'invisible' : ''
  return (
    <Button
      look="primary"
      size={wide ? 'lg' : 'md'}
      aria-haspopup="dialog"
      className={wide ? `min-h-11 w-full ${hidden}` : hidden}
      onClick={(event) => flow.open(id, event.currentTarget)}
    >
      {wide ? 'Connect wallet' : 'Connect'}
    </Button>
  )
}
