import type { ReactNode } from 'react'

export interface SpinnerProps {
  size?: number
  className?: string
}

/** CSS 旋转指示器（不引图标库） */
export function Spinner({ size = 14, className }: SpinnerProps): ReactNode {
  return (
    <span
      className={['spinner', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      role="status"
      aria-label="运行中"
    />
  )
}

export default Spinner
