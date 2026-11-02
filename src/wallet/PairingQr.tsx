import { useEffect, useState } from 'react'
import { encode } from 'uqr'
import type { Connector } from 'wagmi'
import { Button } from '#/ui/primitives'

const REVEAL_MS = 300

export function PairingQr({ connector, onBack }: { connector: Connector; onBack: () => void }) {
  const [uri, setUri] = useState<string | null>(null)
  useEffect(() => {
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type === 'display_uri') setUri(String(data))
    }
    connector.emitter.on('message', onMessage)
    return () => connector.emitter.off('message', onMessage)
  }, [connector])

  return (
    <>
      <div className="grid justify-items-center gap-3">
        <div className="relative rounded-lg bg-surface p-2.5">
          {uri ? (
            <>
              <Qr text={uri} />
              <span
                aria-hidden
                className="absolute inset-x-2.5 top-2.5 hidden h-1 bg-linear-to-r from-transparent via-accent to-transparent opacity-80 motion-safe:block motion-safe:animate-scan"
              />
            </>
          ) : (
            <p className="grid size-72 place-items-center text-level3">Opening a pairing link…</p>
          )}
        </div>
        <p className="text-center text-level2">Open a phone wallet that supports WalletConnect and scan.</p>
      </div>
      <div className="mt-5 flex gap-2">
        <Button look="secondary-raised" size="lg" className="flex-1" data-focus onClick={onBack}>
          Back
        </Button>
        <Button
          look="secondary-raised"
          size="lg"
          className="flex-1"
          disabled={!uri}
          onClick={() => uri && void navigator.clipboard.writeText(uri)}
        >
          Copy link
        </Button>
      </div>
    </>
  )
}

function Qr({ text }: { text: string }) {
  const { size, data } = encode(text, { border: 2 })
  const middle = (size - 1) / 2
  const reach = Math.hypot(middle, middle)
  const modules = data.flatMap((row, top) =>
    row.flatMap((dark, left) =>
      dark ? [{ left, top, delay: Math.round((Math.hypot(left - middle, top - middle) / reach) * REVEAL_MS) }] : [],
    ),
  )
  return (
    <svg
      role="img"
      aria-label="WalletConnect pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="block size-72 rounded-sm bg-accent fill-ink-contrast"
    >
      {modules.map(({ left, top, delay }) => (
        <rect
          key={`${left}:${top}`}
          x={left}
          y={top}
          width="1"
          height="1"
          className="origin-center transform-fill motion-safe:animate-module"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </svg>
  )
}
