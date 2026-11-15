import { QueryClient } from '@tanstack/react-query'
import { retryDelay } from './retry-delay'

export function getContext() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay } } })

  return {
    queryClient,
  }
}
