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
import type { Connector, CreateConnectorFn } from 'wagmi'
import { UserRejectedRequestError, erc20Abi, formatUnits } from 'viem'
import { isRecord } from '@tape/core/json'
import { shortAddress } from '#/ui/format'
import { Button, Select } from '#/ui/primitives'
import { track } from '#/analytics/track'
import { USDC, chains, isChainId } from './config'
import { PairingQr } from './PairingQr'

const LABEL: Record<string, string> = { injected: 'Connect wallet', walletConnect: 'WalletConnect' }

const kindOf = (connector: Connector | CreateConnectorFn) =>
  'type' in connector && (connector.type === 'injected' || connector.type === 'walletConnect')
    ? connector.type
    : 'other'

export function WalletButton({ wide = false }: { wide?: boolean }) {
  const { address, chainId, isConnected } = useConnection()
  const connectors = useConnectors()
  // Callbacks on the hook, not on connect(): the ticket's button unmounts as soon as the wallet connects.
  const {
    mutate: connect,
    isPending,
    error,
    reset,
  } = useConnect({
    mutation: {
      onSuccess: (_data, { connector }) => track({ event: 'wallet_connected', connector: kindOf(connector) }),
      onError: (failure, { connector }) =>
        track({
          event: 'wallet_connect_failed',
          connector: kindOf(connector),
          reason:
            failure instanceof ProviderNotFoundError
              ? 'no-wallet'
              : isRecord(failure) && failure.code === UserRejectedRequestError.code
                ? 'rejected'
                : 'other',
        }),
    },
  })
  const { mutate: disconnect } = useDisconnect()
  const { mutate: switchChain } = useSwitchChain()
  const [chosen, setChosen] = useState<Connector | null>(null)
  if (!isConnected || !address) {
    const pairing = isPending && chosen?.type === 'walletConnect' ? chosen : null
    return (
      <div className={`flex flex-col gap-1 ${wide ? 'items-stretch' : 'items-end'}`}>
        <div className={wide ? 'grid auto-cols-fr grid-flow-col gap-2' : 'flex gap-2'}>
          {connectors.map((connector) => (
            <Button
              key={connector.uid}
              look="primary"
              size={wide ? 'lg' : 'md'}
              className={wide ? 'min-h-11' : undefined}
              disabled={isPending}
              onClick={() => {
                setChosen(connector)
                connect({ connector })
              }}
            >
              {isPending && chosen === connector ? 'Connecting…' : (LABEL[connector.type] ?? connector.name)}
            </Button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-xs text-level3">
            {error instanceof ProviderNotFoundError
              ? `No wallet in this browser.${connectors.length > 1 ? ' Try WalletConnect.' : ''}`
              : error.message.split('\n')[0]}
          </p>
        )}
        <PairingQr connector={pairing} onCancel={reset} />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="chain">
        Network
      </label>
      <Select
        size="md"
        id="chain"
        value={chainId}
        onChange={(value) => {
          const id = Number(value)
          if (isChainId(id)) switchChain({ chainId: id })
        }}
      >
        {chains.map((chain) => (
          <option key={chain.id} value={chain.id}>
            {chain.name}
          </option>
        ))}
      </Select>
      <Button look="secondary" size="md" className="num" onClick={() => disconnect()} title="Disconnect">
        {shortAddress(address)}
      </Button>
    </div>
  )
}

export function useUsdcBalance(): { readonly chain: string; readonly amount: string } | null {
  const { address, chainId, chain } = useConnection()
  const token = chainId ? USDC[chainId] : undefined
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
