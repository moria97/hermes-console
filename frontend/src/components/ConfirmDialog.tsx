import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: 'primary' | 'danger'
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  variant = 'primary',
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel, onConfirm])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onCancel} role="dialog" aria-modal="true">
      <div className={`modal ${variant}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">
          <AlertTriangle size={20} />
        </div>
        <h3 className="modal-title">{title}</h3>
        {description && <p className="modal-desc">{description}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${variant === 'danger' ? 'danger-solid' : 'primary'}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
