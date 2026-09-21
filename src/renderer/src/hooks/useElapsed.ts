import { useEffect, useState } from 'react'

/**
 * 运行中每秒自增的已运行时长（毫秒）。
 * running 为 false 时冻结在 0，避免无意义的 interval。
 */
export function useElapsed(running: boolean, startedAt: number | null): number {
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])

  if (!running || !startedAt) return 0
  return Math.max(0, now - startedAt)
}
