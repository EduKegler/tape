import { useEffect, useState } from 'react'
import { encode } from 'uqr'
import type { Connector } from 'wagmi'
import { Button, Dialog } from '#/ui/primitives'

export function PairingQr({ connector, onCancel }: { connector: Connector | null; onCancel: () => void }) {
  return (
    <Dialog open={connector !== null} onClose={onCancel} title="Connect with WalletConnect" width="narrow">
      {connector && <Pairing connector={connector} onCancel={onCancel} />}
    </Dialog>
  )
}

function Pairing({ connector, onCancel }: { connector: Connector; onCancel: () => void }) {
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
      <p className="text-level2">Scan with your phone wallet</p>
      {uri ? (
        <Qr text={uri} />
      ) : (
        <p className="flex size-60 items-center justify-center self-center text-level3">Opening a pairing link…</p>
      )}
      <div className="flex w-full justify-between">
        <Button look="quiet" disabled={!uri} onClick={() => uri && void navigator.clipboard.writeText(uri)}>
          Copy link
        </Button>
        <Button look="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  )
}

function Qr({ text }: { text: string }) {
  const { size, data } = encode(text, { border: 2 })
  const path = data
    .flatMap((row, top) => row.flatMap((dark, left) => (dark ? [`M${left} ${top}h1v1h-1z`] : [])))
    .join('')
  return (
    <svg
      role="img"
      aria-label="WalletConnect pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-60 self-center rounded-sm bg-white"
    >
      <path d={path} fill="black" />
    </svg>
  )
}
