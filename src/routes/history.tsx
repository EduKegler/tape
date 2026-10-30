import { createFileRoute } from '@tanstack/react-router'
import { NETWORK } from '#/site'
import { Brand } from '#/ui/Header'
import { History, historySearch } from '#/ui/History'
import { WalletButton } from '#/wallet/Wallet'

export const Route = createFileRoute('/history')({
  validateSearch: historySearch,
  head: () => ({ meta: [{ title: `History · Tape${NETWORK === 'testnet' ? ' testnet' : ''}` }] }),
  component: HistoryRoute,
})

function HistoryRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule px-4 py-2">
        <Brand />
        <h1 className="font-display text-[17px] text-level1">History</h1>
        <div className="ml-auto">
          <WalletButton />
        </div>
      </header>
      <History search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />
    </div>
  )
}
