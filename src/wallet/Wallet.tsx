import { useAccount, useConnect, useConnectors, useDisconnect, useReadContract, useSwitchChain } from 'wagmi'
import { erc20Abi, formatUnits } from 'viem'
import { USDC, chains } from './config'
import { shortAddress } from '#/ui/format'

export function WalletButton() {
  const { address, chainId, isConnected } = useAccount()
  const connectors = useConnectors()
  const { connect, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  if (!isConnected || !address) {
    const injected = connectors[0]
    return (
      <button
        type="button"
        disabled={isPending}
        onClick={() => connect({ connector: injected })}
        className="rounded-full bg-ink px-4 py-1.5 text-[13px] text-ink-contrast disabled:opacity-50"
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
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
  const { address, chainId, chain } = useAccount()
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
