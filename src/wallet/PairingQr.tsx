import { useEffect, useState } from 'react'
import { encode } from 'uqr'
import type { Connector } from 'wagmi'

/** The WalletConnect pairing link as a QR, for a phone wallet to scan. */
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-label="Connect with WalletConnect"
        className="flex w-72 flex-col items-center gap-3 rounded-lg border border-rule bg-panel p-4"
      >
        <p className="text-[13px] text-level1">Scan with your phone wallet</p>
        {uri ? <Qr text={uri} /> : <p className="py-24 text-[12px] text-level3">Opening a pairing link…</p>}
        <div className="flex w-full justify-between">
          <button
            type="button"
            disabled={!uri}
            onClick={() => uri && void navigator.clipboard.writeText(uri)}
            className="text-[12px] text-level3 hover:text-level1 disabled:opacity-50"
          >
            Copy link
          </button>
          <button type="button" onClick={onCancel} className="text-[12px] text-level3 hover:text-level1">
            Cancel
          </button>
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
