import { Button as BaseButton } from '@base-ui/react/button'
import type { ComponentProps } from 'react'

const classes = {
  primary:
    'rounded-sm bg-ink font-medium text-ink-contrast disabled:bg-raised disabled:text-level2 disabled:inset-ring disabled:inset-ring-rule',
  secondary: 'rounded-sm border border-rule text-level2 hover:text-level1 disabled:opacity-40',
  buy: 'h-10 rounded-sm bg-bid text-base font-medium text-ink-contrast disabled:bg-raised disabled:text-level2 disabled:inset-ring disabled:inset-ring-rule',
  sell: 'h-10 rounded-sm bg-ask text-base font-medium text-ink-contrast disabled:bg-raised disabled:text-level2 disabled:inset-ring disabled:inset-ring-rule',
  quiet: 'text-level3 hover:text-level1 disabled:opacity-40',
  toggle:
    'h-6 px-1 text-sm text-level3 hover:text-level1 aria-checked:text-level1 aria-checked:inset-shadow-selected aria-pressed:text-level1 aria-pressed:inset-shadow-selected',
  'side-buy':
    'h-8.5 rounded-sm text-base font-medium capitalize not-aria-pressed:text-level3 not-aria-pressed:hover:text-level1 aria-pressed:bg-bid-wash aria-pressed:text-bid',
  'side-sell':
    'h-8.5 rounded-sm text-base font-medium capitalize not-aria-pressed:text-level3 not-aria-pressed:hover:text-level1 aria-pressed:bg-ask-wash aria-pressed:text-ask',
  row: 'text-left text-level2 hover:bg-level1/5 aria-current:text-level1',
}

const sizes = {
  sm: 'h-6 px-2.5 text-sm',
  md: 'h-8 px-3 text-sm',
  lg: 'h-10 px-3 text-base',
}

type SizedLook = 'primary' | 'secondary'
type Look =
  { look: SizedLook; size: keyof typeof sizes } | { look: Exclude<keyof typeof classes, SizedLook>; size?: never }

export function Button({
  look,
  size,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'className'> & Look & { className?: string }) {
  const own = size ? `${classes[look]} ${sizes[size]}` : classes[look]
  const all = className ? `${own} ${className}` : own
  return look === 'row' ? (
    <button type="button" {...props} className={all} />
  ) : (
    <BaseButton {...props} className={all} />
  )
}
