import { createFileRoute, redirect } from '@tanstack/react-router'
import { toBase } from '@tape/core/ids'
import { campaign } from '#/analytics/campaign'

export const Route = createFileRoute('/')({
  beforeLoad: ({ location }) => {
    throw redirect({
      to: '/$venue/$base',
      params: { venue: 'hyperliquid', base: toBase('BTC') },
      search: { interval: '1m', ...campaign(location.searchStr) },
    })
  },
})
