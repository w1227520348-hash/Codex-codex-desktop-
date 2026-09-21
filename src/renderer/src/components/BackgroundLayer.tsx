/**
 * 背景层：把背景图当成被精确摆放的 <img>，从而支持缩放 / 平移 / 框选。
 *
 * 为什么不用 CSS background-size：
 *  - `cover` 只能铺满，无法缩放、平移、框选
 *  - 用 <img> + 像素定位可以由 computeBackgroundLayout 完全掌控，且永不拉伸变形
 *
 * 自适应：容器尺寸用 ResizeObserver 监听，窗口变化时立即重算，不露白不错位。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAppearanceRuntime } from '@renderer/hooks/useAppearance'
import { computeBackgroundLayout } from '@renderer/utils/background'

interface Size {
  width: number
  height: number
}

function BackgroundLayer(): ReactNode {
  const { backgroundSource, backgroundTransform, markBackgroundFailed } = useAppearanceRuntime()
  const imageRef = useRef<HTMLImageElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 })
  const [natural, setNatural] = useState<Size | null>(null)
  const [broken, setBroken] = useState(false)

  /**
   * 容器尺寸测量**必须**用 ref 回调，不能放在 useEffect(..., []) 里。
   *
   * 踩过的坑：设置是异步从主进程加载的，首帧 backgroundSource 还是 null，
   * 组件直接 return null，于是带 [] 依赖的 effect 首次运行时 containerRef.current 为 null，
   * 之后再也不会重跑 —— 容器尺寸永远停在 0x0，布局计算恒为 null，
   * 表现就是「缩放/平移/框选全部没反应，图只能 100% 铺满」。
   * ref 回调只在节点真正挂载/卸载时触发，与加载时序无关。
   */
  const attachContainer = useCallback((node: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return

    const measure = (): void => {
      setContainer({ width: node.clientWidth, height: node.clientHeight })
    }
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(node)
      observerRef.current = observer
    } else {
      window.addEventListener('resize', measure)
      observerRef.current = { disconnect: () => window.removeEventListener('resize', measure) } as ResizeObserver
    }
  }, [])

  // 换图时清掉加载失败状态
  useLayoutEffect(() => {
    setBroken(false)
  }, [backgroundSource])

  // 量图片原始尺寸。
  // 不能用 <img onLoad>：data URL（尤其是内联 SVG）常常在 React 挂上事件之前就已经 complete，
  // load 事件不会再触发，于是 natural 一直是 null → 缩放/平移/框选全部静默失效。
  // 这里在 layout effect 里主动检查 complete，未完成才监听 load。
  useLayoutEffect(() => {
    const element = imageRef.current
    if (!element) return
    const read = (): void => {
      if (element.naturalWidth > 0 && element.naturalHeight > 0) {
        setNatural({ width: element.naturalWidth, height: element.naturalHeight })
      }
    }
    if (element.complete) {
      read()
      return
    }
    element.addEventListener('load', read, { once: true })
    return () => element.removeEventListener('load', read)
  }, [backgroundSource])

  const layout = natural ? computeBackgroundLayout(container, natural, backgroundTransform) : null

  if (!backgroundSource || broken) return null

  return (
    <div
      className="app-bg"
      aria-hidden="true"
      ref={attachContainer}
      // 这几个 data-* 是给自动化测试与排障用的：能直接看出「量到了什么、走了哪条分支」
      data-container={`${container.width}x${container.height}`}
      data-natural={natural ? `${natural.width}x${natural.height}` : 'none'}
      data-layout={layout ? 'px' : 'fallback'}
    >
      <img
        ref={imageRef}
        key={backgroundSource}
        className="app-bg-img"
        src={backgroundSource}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => {
          setBroken(true)
          markBackgroundFailed('背景图加载失败（地址失效或被拦截），已回退到无背景。')
        }}
        style={
          layout
            ? {
                left: `${layout.left}px`,
                top: `${layout.top}px`,
                width: `${layout.width}px`,
                height: `${layout.height}px`
              }
            : // 还没量到尺寸时先用 cover 顶上，避免首帧闪一下空白
              { left: '0px', top: '0px', width: '100%', height: '100%', objectFit: 'cover' }
        }
      />
    </div>
  )
}

export default BackgroundLayer
