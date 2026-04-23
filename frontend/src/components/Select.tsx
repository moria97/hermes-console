import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export default function Select({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = '请选择',
  className = '',
}: Props) {
  const [open, setOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState<number>(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const current = options.find((o) => o.value === value)

  // Close on click-outside.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Scroll focused option into view on keyboard navigation.
  useEffect(() => {
    if (!open || focusIdx < 0) return
    const list = listRef.current
    const el = list?.children[focusIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx, open])

  const toggle = () => {
    if (disabled) return
    if (!open) {
      // Start with current selection focused.
      setFocusIdx(options.findIndex((o) => o.value === value))
    }
    setOpen(!open)
  }

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        toggle()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx((i) => {
        for (let step = 1; step <= options.length; step++) {
          const next = (i + step) % options.length
          if (!options[next].disabled) return next
        }
        return i
      })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx((i) => {
        for (let step = 1; step <= options.length; step++) {
          const next = (i - step + options.length) % options.length
          if (!options[next].disabled) return next
        }
        return i
      })
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const opt = options[focusIdx]
      if (opt) pick(opt)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`sel ${open ? 'open' : ''} ${disabled ? 'disabled' : ''} ${className}`}
    >
      <button
        type="button"
        className="sel-trigger"
        onClick={toggle}
        onKeyDown={onKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className={`sel-value ${!current ? 'sel-placeholder' : ''}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="sel-chevron" />
      </button>

      {open && (
        <ul ref={listRef} className="sel-panel" role="listbox">
          {options.length === 0 && <li className="sel-empty">无选项</li>}
          {options.map((opt, idx) => {
            const isSelected = opt.value === value
            const isFocused = idx === focusIdx
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                className={[
                  'sel-opt',
                  isSelected ? 'selected' : '',
                  isFocused ? 'focused' : '',
                  opt.disabled ? 'disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseEnter={() => setFocusIdx(idx)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(opt)
                }}
              >
                <span className="sel-opt-label">{opt.label}</span>
                {isSelected && <Check size={14} className="sel-opt-check" />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
