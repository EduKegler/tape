import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/$venue/$base', params: { venue: 'hyperliquid', base: 'BTC' }, search: { interval: '1m' } })
  },
})
