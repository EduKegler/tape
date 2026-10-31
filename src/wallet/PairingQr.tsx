import { useEffect, useState } from 'react'
import { encode } from 'uqr'
import type { Connector } from 'wagmi'
import { Button } from '#/ui/primitives'

export function PairingQr({ connector, onCancel }: { connector: Connector; onCancel: () => void }) {
  const [uri, setUri] = useState<string | null>(null)
  useEffect(() => {
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type === 'display_uri') setUri(String(data))
    }
    connector.emitter.on('message', onMessage)
    return () => connector.emitter.off('message', onMessage)
  }, [connector])

  return (
    <div className="fixed inset-0 z-dialog flex items-center justify-center bg-black/60 motion-safe:animate-fade-in">
      <div
        role="dialog"
        aria-label="Connect with WalletConnect"
        className="flex w-72 flex-col items-center gap-3 rounded-sm border border-rule bg-raised p-4"
      >
        <p className="text-base text-level1">Scan with your phone wallet</p>
        {uri ? <Qr text={uri} /> : <p className="py-24 text-sm text-level3">Opening a pairing link…</p>}
        <div className="flex w-full justify-between">
          <Button look="quiet" disabled={!uri} onClick={() => uri && void navigator.clipboard.writeText(uri)}>
            Copy link
          </Button>
          <Button look="quiet" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function Qr({ text }: { text: string }) {
  const { size, data } = encode(text, { border: 2 })
  const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join('')
  return (
    <svg
      role="img"
      aria-label="WalletConnect pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-60 rounded-sm bg-white"
    >
      <path d={path} fill="black" />
    </svg>
  )
}
