import type { FC, ReactNode } from 'react'

/** A row of mutually exclusive buttons (radio group). */
export const Segmented: FC<{
  label: string
  options: Array<{ id: string; label: ReactNode }>
  value: string | null
  onChange: (id: string) => void
  compact?: boolean
}> = ({ label, options, value, onChange, compact = false }) => (
  <div className={compact ? 'segmented compact' : 'segmented'} role='radiogroup' aria-label={label}>
    {options.map(option => (
      <button
        key={option.id}
        type='button'
        role='radio'
        aria-checked={value === option.id}
        className={value === option.id ? 'active' : ''}
        onClick={() => {
          onChange(option.id)
        }}
      >
        {option.label}
      </button>
    ))}
  </div>
)
