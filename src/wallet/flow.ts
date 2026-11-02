import { ProviderNotFoundError } from 'wagmi'
import { UserRejectedRequestError } from 'viem'
import { isRecord } from '@tape/core/json'

export type ConnectFailure =
  { readonly kind: 'rejected' } | { readonly kind: 'no-wallet' } | { readonly kind: 'other'; readonly message: string }

export function connectFailure(error: unknown): ConnectFailure {
  if (error instanceof ProviderNotFoundError) return { kind: 'no-wallet' }
  if (isRecord(error) && error.code === UserRejectedRequestError.code) return { kind: 'rejected' }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'other', message: message.split('\n')[0] ?? message }
}

interface Listed {
  readonly id: string
  readonly type: string
}

/** wagmi's id for the connector that reads `window.ethereum`, beside one connector per EIP-6963 announcement. */
export const INJECTED_ID = 'injected'

export function browserWallets<TConnector extends Listed>(
  connectors: readonly TConnector[],
  injectedHasProvider: boolean,
): readonly TConnector[] {
  const injected = connectors.filter((connector) => connector.type === 'injected')
  const announced = injected.filter((connector) => connector.id !== INJECTED_ID)
  if (announced.length > 0) return announced
  return injectedHasProvider ? injected : []
}

export function waitClock(elapsedMs: number): string {
  const tenths = Math.floor(Math.max(0, elapsedMs) / 100)
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor((tenths % 600) / 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`
}

const HEX = '0123456789abcdef'
const SETTLE_START_MS = 60
const SETTLE_STEP_MS = 26
const SETTLE_FRAME_MS = 16

export const settleMs = (text: string) => SETTLE_START_MS + text.length * SETTLE_STEP_MS

export function settleFrame(text: string, elapsedMs: number): string {
  const frame = Math.floor(elapsedMs / SETTLE_FRAME_MS)
  return Array.from(text, (char, index) =>
    index < 2 || !/[\da-f]/i.test(char) || elapsedMs >= SETTLE_START_MS + index * SETTLE_STEP_MS
      ? char
      : (HEX[(index * 7 + frame) % HEX.length] ?? char),
  ).join('')
}
