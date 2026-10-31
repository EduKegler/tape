import { createFileRoute, redirect } from '@tanstack/react-router'
import { toBase } from '@tape/core/ids'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({
      to: '/$venue/$base',
      params: { venue: 'hyperliquid', base: toBase('BTC') },
      search: { interval: '1m' },
    })
  },
})
