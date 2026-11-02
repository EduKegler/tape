import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useConnection, useReadContract, useSwitchChain } from 'wagmi'
import { erc20Abi, formatUnits } from 'viem'
import { shortAddress } from '#/ui/format'
import { Button, Select } from '#/ui/primitives'
import { USDC, chains, isChainId } from './config'
import { ConnectButton, useConnectFlow } from './Connect'
import { Disconnect } from './Disconnect'
import type { Held } from './Disconnect'
import { settleFrame, settleMs } from './flow'
import { reducedMotion } from './motion'

export function WalletButton() {
  const { anchor, landing } = useConnectFlow()
  const { address, chainId, connector, isConnected } = useConnection()
  const { mutate: switchChain } = useSwitchChain()
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const [held, setHeld] = useState<Held | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <div
        ref={(element) => {
          anchor(element)
          setSlot(element)
        }}
        className="flex items-center gap-2"
      >
        {isConnected && address && landing !== 'holding' ? (
          <>
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
            <AddressChip
              address={address}
              hidden={open}
              onOpen={(opener) => {
                if (!connector) return
                setHeld({ opener, address, connector })
                setOpen(true)
              }}
            />
          </>
        ) : (
          <ConnectButton />
        )}
      </div>
      <Disconnect open={open} held={held} anchor={slot} onClosed={() => setOpen(false)} />
    </>
  )
}

function AddressChip({
  address,
  hidden,
  onOpen,
}: {
  address: string
  hidden: boolean
  onOpen: (opener: HTMLElement) => void
}) {
  const { landing, chip } = useConnectFlow()
  const text = useRef<HTMLSpanElement>(null)
  const short = shortAddress(address)
  const settled = useEffectEvent(() => short)
  useEffect(() => {
    const element = text.current
    if (landing !== 'landed' || !element || reducedMotion()) return
    const target = settled()
    const start = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const elapsed = now - start
      element.textContent = settleFrame(target, elapsed)
      if (elapsed < settleMs(target)) frame = requestAnimationFrame(tick)
    })
    return () => {
      cancelAnimationFrame(frame)
      element.textContent = target
    }
  }, [landing])
  return (
    <Button
      ref={chip}
      look="secondary"
      size="md"
      aria-label={short}
      aria-haspopup="dialog"
      title="Disconnect"
      className={`relative ${landing === 'landing' || hidden ? 'invisible' : ''}`}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {landing === 'landed' && <span aria-hidden className="pointer-events-none absolute inset-0 wash rounded-md" />}
      <span key={short} ref={text} className="num relative">
        {short}
      </span>
    </Button>
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
