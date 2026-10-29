import type { TradeError } from '#/trade/types'

/** One sentence per kind. A new kind breaks the build here until it has words. */
export function describeError(error: TradeError): { readonly title: string; readonly detail: string | null } {
  switch (error.kind) {
    case 'wallet-rejected':
      return { title: 'You declined in the wallet.', detail: null }
    case 'needs-setup':
      return { title: 'The venue does not know this trading key yet.', detail: error.detail }
    case 'no-account':
      return { title: 'The venue has no account for this wallet. Deposit first.', detail: error.detail }
    case 'insufficient-margin':
      return { title: 'Not enough margin for this order.', detail: error.detail }
    case 'invalid-order':
      return { title: 'The venue rules reject this order.', detail: error.detail }
    case 'rejected':
      return { title: 'The venue rejected it.', detail: error.detail }
    case 'rate-limited':
      return { title: 'Too many requests. Wait a few seconds.', detail: error.detail }
    case 'unsupported':
      return { title: 'This venue does not offer that.', detail: error.detail }
    case 'unreachable':
      return { title: 'Could not reach the venue. Nothing was sent.', detail: error.detail }
    case 'unknown-outcome':
      return { title: 'Sent, but no answer came back. Check your orders before sending again.', detail: error.detail }
    case 'unexpected':
      return { title: 'Something went wrong in Tape.', detail: error.detail }
  }
}
