import { Button as BaseButton } from '@base-ui/react/button'
import type { ComponentProps } from 'react'

const classes = {
  quiet: 'text-level3 hover:text-level1',
  'quiet-xs': 'text-xs text-level3 hover:text-level1',
  'quiet-sm': 'text-sm text-level3 hover:text-level1 disabled:opacity-50',
  danger: 'text-level3 hover:text-level1 disabled:opacity-40',
  inline: 'hover:text-level1',
  link: 'text-level3 underline underline-offset-2 hover:text-level1',
  primary: 'h-6 rounded-sm bg-ink px-2.5 text-sm font-medium text-ink-contrast',
  'primary-block':
    'h-10 rounded-sm bg-ink px-3 text-base font-medium text-ink-contrast disabled:bg-raised disabled:text-level2 disabled:inset-ring disabled:inset-ring-rule',
  'primary-connect': 'h-8.5 rounded-sm bg-ink px-3 text-base font-medium text-ink-contrast disabled:opacity-50',
  buy: 'h-10 rounded-sm bg-bid text-base font-medium text-ink-contrast disabled:bg-raised disabled:text-level2 disabled:inset-ring disabled:inset-ring-rule',
  sell: 'h-10 rounded-sm bg-ask text-base font-medium text-ink-contrast disabled:bg-raised disabled:text-level2 disabled:inset-ring disabled:inset-ring-rule',
  outline: 'h-6 rounded-sm border border-rule px-2.5 text-sm text-level2 hover:text-level1 disabled:opacity-40',
  'outline-block': 'h-10 rounded-sm border border-ink text-base text-level1 disabled:opacity-40',
  'outline-wallet': 'num h-8 rounded-sm border border-rule px-2 text-sm text-level1 hover:border-level3',
  segment:
    'h-6 text-sm transition-colors duration-fast not-aria-checked:text-level3 not-aria-checked:hover:text-level1 aria-checked:text-level1 aria-checked:inset-shadow-selected',
  preset: 'h-6 px-1 not-aria-pressed:hover:text-level1 aria-pressed:text-level1 aria-pressed:inset-shadow-selected',
  'side-buy':
    'h-8.5 rounded-sm text-base font-medium capitalize not-aria-pressed:text-level3 not-aria-pressed:hover:text-level1 aria-pressed:bg-bid-wash aria-pressed:text-bid',
  'side-sell':
    'h-8.5 rounded-sm text-base font-medium capitalize not-aria-pressed:text-level3 not-aria-pressed:hover:text-level1 aria-pressed:bg-ask-wash aria-pressed:text-ask',
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
