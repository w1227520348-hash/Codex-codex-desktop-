import { useEffect, useState } from 'react'
import type { ThemeMode } from '@shared/types'

export type ResolvedTheme = 'light' | 'dark'

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把主题写到 document.documentElement 的 data-theme 上。
 * theme === 'system' 时跟随 prefers-color-scheme，并监听其变化。
 */
export function useTheme(theme: ThemeMode): ResolvedTheme {
  const [resolved, setResolved] = useState<ResolvedTheme>(() => (theme === 'system' ? systemTheme() : theme))

  useEffect(() => {
    if (theme !== 'system') {
      setResolved(theme)
      return
    }

    setResolved(systemTheme())
    if (typeof window.matchMedia !== 'function') return

    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent): void => {
      setResolved(event.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.style.colorScheme = resolved
  }, [resolved])

  return resolved
}
