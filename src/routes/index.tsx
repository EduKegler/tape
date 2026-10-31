import { createFileRoute, redirect } from '@tanstack/react-router'
import type { Base } from '@tape/core/ids'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({
      to: '/$venue/$base',
      params: { venue: 'hyperliquid', base: 'BTC' as Base },
      search: { interval: '1m' },
    })
  },
})
