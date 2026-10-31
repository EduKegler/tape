import { createStore } from '@tanstack/store'
import { toBps } from '@tape/trade/types'
import type { Bps } from '@tape/trade/types'

export const proposedPrice = createStore<{ readonly price: string; readonly at: number } | null>(null)

export function proposePrice(price: string): void {
  proposedPrice.setState(() => ({ price: price.replaceAll(',', ''), at: Date.now() }))
}

export const SLIPPAGE_STEPS = [10, 50, 100, 300] as const

export const slippageBps = createStore<Bps>(toBps(100))

export const closeSlippageBps = createStore<Bps>(toBps(100))
