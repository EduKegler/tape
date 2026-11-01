export function SideMark({ side, className = 'size-3.5' }: { side: 'buy' | 'sell'; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 12 10" className={`inline-block shrink-0 fill-current ${className}`}>
      <path d={side === 'buy' ? 'M6 0 12 10H0Z' : 'M6 10 0 0h12Z'} />
    </svg>
  )
}
