import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { IconClose } from '@renderer/components/icons'

export interface ToastProps {
  message: string | null
  onDismiss: () => void
  /** 自动消失时间（毫秒），0 表示手动关闭 */
  duration?: number
}

/** 顶部居中的轻量错误提示 */
export function Toast({ message, onDismiss, duration = 8000 }: ToastProps): ReactNode {
  useEffect(() => {
    if (!message || duration <= 0) return
    const timer = window.setTimeout(onDismiss, duration)
    return () => window.clearTimeout(timer)
  }, [message, duration, onDismiss])

  if (!message) return null

  return (
    <div className="toast" role="alert">
      <span className="toast-icon" aria-hidden="true">
        ⚠
      </span>
      <span className="toast-text">{message}</span>
      <button type="button" className="icon-button toast-close" aria-label="关闭提示" onClick={onDismiss}>
        <IconClose size={14} />
      </button>
    </div>
  )
}

export default Toast
