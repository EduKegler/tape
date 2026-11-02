import { Link, createFileRoute } from '@tanstack/react-router'
import { NETWORK } from '#/site'
import { TRADE_CONFIG } from '#/trade/config'
import { Brand } from '#/ui/Header'
import { TextLink } from '#/ui/primitives/TextLink'
import { WalletButton } from '#/wallet/Wallet'

export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: `Terms · Tape${NETWORK === 'testnet' ? ' testnet' : ''}` }] }),
  component: TermsRoute,
})

const HYPERLIQUID_TERMS = 'https://app.hyperliquid.xyz/terms'

function hyperliquidFee(): string {
  const builder = TRADE_CONFIG.hyperliquid.builder
  if (!builder) return 'Tape charges no fee on Hyperliquid.'
  return `Tape adds a builder fee of ${builder.f / 10} bp (${builder.f / 1000}%) of the notional to each Hyperliquid order. Your wallet approves this fee before your first order.`
}

function TermsRoute() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-surface px-4 py-2">
        <Brand />
        <h1 className="text-base text-level1">Terms</h1>
        <Link to="/" className="text-level3 hover:text-level1">
          Back to trading
        </Link>
        <div className="ml-auto">
          <WalletButton />
        </div>
      </header>
      <main className="flex flex-col gap-4 p-4 text-level2">
        <section className="flex max-w-160 flex-col gap-2">
          <h2 className="text-sm text-level1">An interface, not a custodian</h2>
          <p>
            Tape is an interface to the venues. It holds none of your funds and never sees your wallet&apos;s key.
            Orders are signed in your browser and sent straight to the venue, which holds your account.
          </p>
        </section>
        <section className="flex max-w-160 flex-col gap-2">
          <h2 className="text-sm text-level1">Fees</h2>
          <p>{hyperliquidFee()}</p>
        </section>
        <section className="flex max-w-160 flex-col gap-2">
          <h2 className="text-sm text-level1">Where perps are not allowed</h2>
          <p>
            Do not trade perps through Tape if you are in, or a citizen or resident of, a place that section 1.6 of
            Hyperliquid&apos;s terms restricts, such as the United States, Ontario, or a place under sanctions or export
            controls. Do not use a VPN or proxy to hide where you are.
          </p>
        </section>
        <section className="flex max-w-160 flex-col gap-2">
          <h2 className="text-sm text-level1">The venue&apos;s terms</h2>
          <p>
            Trading on Hyperliquid also falls under{' '}
            <TextLink href={HYPERLIQUID_TERMS} newTab>
              Hyperliquid&apos;s terms
            </TextLink>
            .
          </p>
        </section>
      </main>
    </div>
  )
}
