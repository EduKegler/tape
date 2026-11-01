export function ErrorMark({ className = 'mt-0.5 size-3.5 shrink-0' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className={`text-err ${className}`}>
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3.8v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10.2" r="0.9" fill="currentColor" />
    </svg>
  )
}
