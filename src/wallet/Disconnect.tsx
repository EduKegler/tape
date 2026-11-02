import { useEffectEvent, useLayoutEffect, useRef } from 'react'
import { useDisconnect } from 'wagmi'
import type { Connector } from 'wagmi'
import { shortAddress } from '#/ui/format'
import { Button, Popover } from '#/ui/primitives'
import { WalletTile } from './Connect'
import { fade, foldInto, growFrom, nextFrame, reducedMotion } from './motion'

export interface Held {
  readonly opener: HTMLElement
  readonly address: string
  readonly connector: Connector
}

export function Disconnect({
  open,
  held,
  anchor,
  onClosed,
}: {
  open: boolean
  held: Held | null
  anchor: HTMLElement | null
  onClosed: () => void
}) {
  const layer = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const { mutateAsync: disconnect } = useDisconnect()
  const parts = () => ({ layer: layer.current, backdrop: backdrop.current, body: body.current })

  const finish = async (leave: () => Promise<unknown>) => {
    if (busy.current) return
    busy.current = true
    await leave()
    onClosed()
    busy.current = false
  }
  const stay = () =>
    finish(() => foldInto(parts(), held?.opener.isConnected ? held.opener.getBoundingClientRect() : null))
  const leave = () =>
    finish(async () => {
      const duration = reducedMotion() ? 100 : 160
      void fade(backdrop.current, 0, duration)
      await fade(layer.current?.parentElement ?? null, 0, duration)
      await disconnect()
      await nextFrame()
    })

  return (
    <Popover
      open={open}
      onClose={() => void stay()}
      anchor={anchor}
      title="Disconnect this wallet?"
      size="sm"
      layerRef={layer}
      backdropRef={backdrop}
      bodyRef={body}
      initialFocus={() => body.current?.querySelector<HTMLElement>('[data-focus]') ?? null}
      finalFocus={() =>
        held?.opener.isConnected
          ? held.opener
          : (anchor?.querySelector<HTMLElement>('[aria-haspopup="dialog"]') ?? null)
      }
    >
      {held && (
        <Body
          held={held}
          onMount={() => void growFrom(parts(), held.opener.getBoundingClientRect())}
          onStay={() => void stay()}
          onLeave={() => void leave()}
        />
      )}
    </Popover>
  )
}

function Body({
  held,
  onMount,
  onStay,
  onLeave,
}: {
  held: Held
  onMount: () => void
  onStay: () => void
  onLeave: () => void
}) {
  const mount = useEffectEvent(onMount)
  useLayoutEffect(() => {
    // React attaches the Popover's refs after this child's layout effect, so the morph reads them a microtask later.
    queueMicrotask(() => mount())
  }, [])
  return (
    <>
      <div data-stagger className="flex items-center gap-3 rounded-lg bg-option p-3">
        <WalletTile connector={held.connector} className="size-8 rounded-md" />
        <div className="min-w-0">
          <p className="truncate font-medium text-level1">{held.connector.name}</p>
          <p className="num text-level2" title={held.address}>
            {shortAddress(held.address)}
          </p>
        </div>
      </div>
      <div data-stagger className="mt-4 flex gap-2">
        <Button look="secondary-raised" size="md" className="flex-1" onClick={onStay}>
          Stay connected
        </Button>
        <Button look="primary" size="md" className="flex-1" data-focus onClick={onLeave}>
          Disconnect
        </Button>
      </div>
    </>
  )
}
