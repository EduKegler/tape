import { useState } from 'react'
import {
  ProviderNotFoundError,
  useConnection,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from 'wagmi'
import type { Connector } from 'wagmi'
import { erc20Abi, formatUnits } from 'viem'
import { USDC, chains } from './config'
import { shortAddress } from '#/ui/format'
import { PairingQr } from './PairingQr'

const LABEL: Record<string, string> = { injected: 'Connect wallet', walletConnect: 'WalletConnect' }

export function WalletButton() {
  const { address, chainId, isConnected } = useConnection()
  const connectors = useConnectors()
  const { mutate: connect, isPending, error, reset } = useConnect()
  const { mutate: disconnect } = useDisconnect()
  const { mutate: switchChain } = useSwitchChain()
  const [chosen, setChosen] = useState<Connector | null>(null)
  if (!isConnected || !address) {
    const pairing = isPending && chosen?.type === 'walletConnect' ? chosen : null
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              type="button"
              disabled={isPending}
              onClick={() => {
                setChosen(connector)
                connect({ connector })
              }}
              className="rounded-full bg-ink px-4 py-1.5 text-[13px] text-ink-contrast disabled:opacity-50"
            >
              {isPending && chosen === connector ? 'Connecting…' : (LABEL[connector.type] ?? connector.name)}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-[11px] text-level3">
            {error instanceof ProviderNotFoundError
              ? `No wallet in this browser.${connectors.length > 1 ? ' Try WalletConnect.' : ''}`
              : error.message.split('\n')[0]}
          </p>
        )}
        {pairing && <PairingQr connector={pairing} onCancel={reset} />}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="chain">
        Network
      </label>
      <select
        id="chain"
        value={chainId}
        onChange={(e) => switchChain({ chainId: Number(e.target.value) as (typeof chains)[number]['id'] })}
        className="rounded-full border border-rule bg-panel px-2 py-1 text-[12px] text-level2"
      >
        {chains.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => disconnect()}
        className="num rounded-full border border-rule px-3 py-1 text-[12px] text-level1 hover:border-level3"
        title="Disconnect"
      >
        {shortAddress(address)}
      </button>
    </div>
  )
}

export function useUsdcBalance(): { readonly chain: string; readonly amount: string } | null {
  const { address, chainId, chain } = useConnection()
  const token = chainId ? USDC[chainId as keyof typeof USDC] : undefined
  const { data } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && token) },
  })
  if (!address || !chain) return null
  if (!token) return { chain: chain.name, amount: 'unsupported network' }
  return {
    chain: chain.name,
    amount:
      data === undefined ? '…' : Number(formatUnits(data, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 }),
  }
}
