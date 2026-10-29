import { createStore } from '@tanstack/store'

/** A book row or trade click proposes a price to the ticket. The ticket owns what it does with it. */
export const proposedPrice = createStore<{ readonly price: string; readonly at: number } | null>(null)

export function proposePrice(price: string): void {
  proposedPrice.setState(() => ({ price: price.replaceAll(',', ''), at: Date.now() }))
}

/** Max slippage for market and close orders, in basis points. */
export const slippageBps = createStore(100)
