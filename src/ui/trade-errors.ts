import type { TradeError } from '@tape/trade/types'

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
      return {
        title: 'Sent, but no answer came back. Check positions, orders and fills before sending again.',
        detail: error.detail,
      }
    case 'unexpected':
      return { title: 'Something went wrong in Tape.', detail: error.detail }
  }
}

const ORDER_RESULT: Record<TradeError['kind'], string> = {
  'wallet-rejected': 'Not sent',
  'needs-setup': 'Not sent',
  'no-account': 'Rejected',
  'insufficient-margin': 'Rejected',
  'invalid-order': 'Rejected',
  rejected: 'Rejected',
  'rate-limited': 'Rejected',
  unsupported: 'Rejected',
  unreachable: 'Not sent',
  'unknown-outcome': 'No answer',
  unexpected: 'Failed',
}

export function orderResult(error: TradeError): string {
  return ORDER_RESULT[error.kind]
}

const READ_FAILURES: Partial<Record<TradeError['kind'], string>> = {
  unreachable: 'The venue did not answer.',
  'rate-limited': 'The venue is limiting requests. Retry in a few seconds.',
  rejected: 'The venue refused the request.',
}

export function readFailure(error: TradeError): string {
  return READ_FAILURES[error.kind] ?? 'Tape could not read the answer.'
}
