import type { ReactNode } from 'react'

/**
 * 内联 SVG 图标集（不引图标库）。
 * 统一 16×16 视口、currentColor 描边，随文字颜色与主题变化。
 */

export interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconPlus(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Svg>
  )
}

export function IconFolder(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M2 4.4A1.4 1.4 0 0 1 3.4 3h2.3l1.4 1.7h5.5A1.4 1.4 0 0 1 14 6.1v5.5A1.4 1.4 0 0 1 12.6 13H3.4A1.4 1.4 0 0 1 2 11.6Z" />
    </Svg>
  )
}

export function IconGear(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </Svg>
  )
}

export function IconStethoscope(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3.4 2.4v3.2a2.6 2.6 0 0 0 5.2 0V2.4" />
      <path d="M6 8.2v1.4a3.4 3.4 0 0 0 3.4 3.4h.4" />
      <circle cx="12" cy="12.4" r="1.6" />
    </Svg>
  )
}

export function IconTrash(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M2.8 4.4h10.4M6.2 4.4V3.2h3.6v1.2M4.2 4.4l.6 8.1a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8.1" />
    </Svg>
  )
}

export function IconClose(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function IconChevronRight(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M6 3.2L10.8 8 6 12.8" />
    </Svg>
  )
}

export function IconChevronDown(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3.2 6L8 10.8 12.8 6" />
    </Svg>
  )
}

export function IconTerminal(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <path d="M4.6 6.4L6.8 8l-2.2 1.6M8.4 10h3" />
    </Svg>
  )
}

export function IconFile(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 2.4h4.6L12 5.8v7.8H4z" />
      <path d="M8.6 2.4v3.4H12" />
    </Svg>
  )
}

export function IconAttach(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M10.6 4.6L5.4 9.8a1.9 1.9 0 002.7 2.7l4.6-4.6a3.2 3.2 0 00-4.5-4.5L3.6 8a4.4 4.4 0 006.2 6.2l3.6-3.6" />
    </Svg>
  )
}

export function IconDiff(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 2.4h5.6L13 5.8v7.8H4z" />
      <path d="M6.4 8.4h3.2M6.4 10.6h3.2M8 7v4.6" />
    </Svg>
  )
}

export function IconActivity(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M1.6 8h2.6l1.6-3.6L8 12l1.8-4.6 1.2 2h3.4" />
    </Svg>
  )
}

export function IconStop(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconSend(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M2.4 8L13.6 2.6 8.8 13.4 7.6 9.6z" />
    </Svg>
  )
}

export function IconSun(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
    </Svg>
  )
}

export function IconMoon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M12.8 9.6A5.2 5.2 0 0 1 6.4 3.2a5.6 5.6 0 1 0 6.4 6.4Z" />
    </Svg>
  )
}

export function IconShield(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 1.8l5 1.8v4.2c0 3-2.1 5.2-5 6.4-2.9-1.2-5-3.4-5-6.4V3.6z" />
      <path d="M6 8l1.6 1.6L10.4 6.8" />
    </Svg>
  )
}

export function IconWarning(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 2.2l6 10.6H2z" />
      <path d="M8 6.4v3.2M8 11.4h.01" />
    </Svg>
  )
}

export function IconRefresh(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
      <path d="M13.4 2.6v2.8h-2.8" />
    </Svg>
  )
}

export function IconRobot(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="10" height="7.4" rx="1.6" />
      <path d="M8 2.2V5M6 8.4h.01M10 8.4h.01M6.4 10.6h3.2" />
    </Svg>
  )
}

/**
 * 空状态用的 Q 版小吉祥物（默认插图，可被「空状态插图」槽位替换成自定义图）。
 * 纯内联矢量：不引资源、不依赖 currentColor、任意尺寸都清晰。
 */
export function IconCuteMascot({ size = 84 }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden="true">
      <path d="M26 30 C 20 16, 30 8, 38 18 Z" fill="#ffb3d9" />
      <path d="M70 30 C 76 16, 66 8, 58 18 Z" fill="#ffb3d9" />
      <ellipse cx="48" cy="54" rx="32" ry="29" fill="#fff0f7" stroke="#ff9dc9" strokeWidth="2.5" />
      <ellipse cx="37" cy="52" rx="4.2" ry="5" fill="#4a3550" />
      <ellipse cx="59" cy="52" rx="4.2" ry="5" fill="#4a3550" />
      <circle cx="38.6" cy="49.6" r="1.5" fill="#ffffff" />
      <circle cx="60.6" cy="49.6" r="1.5" fill="#ffffff" />
      <ellipse cx="28" cy="62" rx="6" ry="3.6" fill="#ffb3d9" opacity="0.75" />
      <ellipse cx="68" cy="62" rx="6" ry="3.6" fill="#ffb3d9" opacity="0.75" />
      <path d="M44 63 q4 5 8 0" stroke="#4a3550" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M80 22 l2.6 5.4 5.4 2.6 -5.4 2.6 -2.6 5.4 -2.6 -5.4 -5.4 -2.6 5.4 -2.6 Z" fill="#ffe3a3" />
      <path d="M16 68 l2 4 4 2 -4 2 -2 4 -2 -4 -4 -2 4 -2 Z" fill="#a8ecd4" />
    </svg>
  )
}
