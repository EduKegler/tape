export function Checkbox(props: {
  label: string
  name: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-level2">
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          name={props.name}
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
          className="peer size-4 appearance-none rounded-sm border border-edge bg-inset checked:border-level1 checked:bg-level1"
        />
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="pointer-events-none absolute inset-0 hidden size-4 fill-none stroke-ink-contrast stroke-2 peer-checked:block"
        >
          <path d="m4 8.5 2.5 2.5L12 5.5" />
        </svg>
      </span>
      {props.label}
    </label>
  )
}
