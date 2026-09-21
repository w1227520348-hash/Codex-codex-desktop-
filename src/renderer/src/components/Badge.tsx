import type { ReactNode } from 'react'
import type { BadgeTone } from '@renderer/utils/format'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  pulse?: boolean
  title?: string
}

export function Badge({ tone = 'neutral', children, pulse = false, title }: BadgeProps): ReactNode {
  const classes = ['badge', `badge-${tone}`, pulse ? 'badge-pulse' : ''].filter(Boolean).join(' ')
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  )
}

export interface StatusDotProps {
  tone: BadgeTone
  pulse?: boolean
}

/** 活动流左侧的状态点 */
export function StatusDot({ tone, pulse = false }: StatusDotProps): ReactNode {
  return <span className={['dot', `dot-${tone}`, pulse ? 'dot-pulse' : ''].filter(Boolean).join(' ')} />
}
