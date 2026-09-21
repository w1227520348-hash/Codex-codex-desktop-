import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 让容器始终贴底；用户手动向上滚动时暂停自动贴底，
 * 回到接近底部后恢复。
 */
export function useStickToBottom<T extends HTMLElement>(
  dependency: unknown
): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const onScroll = (): void => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      stickRef.current = distance < 72
    }

    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const element = ref.current
    if (!element || !stickRef.current) return
    element.scrollTop = element.scrollHeight
  }, [dependency])

  return ref
}
