import { createStore } from '@tanstack/store'

export const proposedPrice = createStore<{ readonly price: string; readonly at: number } | null>(null)

export function proposePrice(price: string): void {
  proposedPrice.setState(() => ({ price: price.replaceAll(',', ''), at: Date.now() }))
}

export const slippageBps = createStore(100)
