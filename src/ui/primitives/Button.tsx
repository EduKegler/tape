import { Button as BaseButton } from '@base-ui/react/button'
import type { ComponentProps } from 'react'

const classes = {
  quiet: 'text-level3 hover:text-level1',
  'quiet-xs': 'text-xs text-level3 hover:text-level1',
  'quiet-sm': 'text-sm text-level3 hover:text-level1 disabled:opacity-50',
  danger: 'text-level3 hover:text-ask disabled:opacity-40',
  inline: 'hover:text-level1',
  link: 'text-level3 underline underline-offset-2 hover:text-level1',
  primary: 'rounded-full bg-ink px-3 py-0.5 text-sm font-medium text-ink-contrast hover:opacity-90',
  'primary-block': 'rounded-full bg-ink py-1.5 text-base text-ink-contrast disabled:opacity-40',
  'primary-connect': 'rounded-full bg-ink px-4 py-1.5 text-base text-ink-contrast disabled:opacity-50',
  buy: 'rounded-full bg-bid py-2 text-base text-surface disabled:opacity-40',
  sell: 'rounded-full bg-ask py-2 text-base text-surface disabled:opacity-40',
  outline: 'rounded-full border border-rule px-2.5 py-0.5 text-sm text-level2 hover:text-level1 disabled:opacity-40',
  'outline-block': 'rounded-full border border-ink py-1.5 text-base text-level1 disabled:opacity-40',
  'outline-wallet': 'num rounded-full border border-rule px-3 py-1 text-sm text-level1 hover:border-level3',
  segment:
    'rounded-full px-2.5 py-0.5 text-sm transition-colors duration-fast not-aria-checked:text-level3 not-aria-checked:hover:text-level2 aria-checked:bg-level1/12 aria-checked:text-level1',
  preset:
    'rounded-full px-2 py-0.5 not-aria-pressed:hover:text-level2 aria-pressed:bg-level1/12 aria-pressed:text-level1',
  'side-buy':
    'rounded-full py-1 text-base capitalize not-aria-pressed:text-level3 aria-pressed:bg-bid-wash aria-pressed:text-bid',
  'side-sell':
    'rounded-full py-1 text-base capitalize not-aria-pressed:text-level3 aria-pressed:bg-ask-wash aria-pressed:text-ask',
  row: 'text-left hover:bg-level1/5',
  record: 'num py-0.5 text-left text-level2 hover:text-level1 aria-current:text-level1',
}

type ButtonLook = keyof typeof classes

export function Button({
  look,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'className'> & { look: ButtonLook; className?: string }) {
  return <BaseButton {...props} className={className ? `${classes[look]} ${className}` : classes[look]} />
}
