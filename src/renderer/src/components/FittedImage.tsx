/**
 * 槽位图片（头像 / 图标 / Logo / 空状态插图）的统一渲染组件。
 *
 * 两条硬性保证：
 *  1. **永不溢出框架**：外层 .fit-frame 绝对定位填满框架，配合框架自身的
 *     overflow:hidden，图片无论如何都出不去。实测踩过：缺少这套约束时，
 *     800×600 的图会塞进 30×30 的框并按原始尺寸渲染，看起来像"变成了全屏背景"。
 *  2. **永不拉伸**：默认模式用 object-fit:cover 居中裁切；自定义裁剪模式下
 *     宽高由 computeBackgroundLayout 等比算出。
 *
 * 默认模式是纯 CSS，不需要测量，天然随框架尺寸自适应；只有用户设置了
 * 缩放/平移/框选时才切到像素定位模式。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BackgroundTransform } from '@shared/types'
import { computeBackgroundLayout, isDefaultTransform } from '@renderer/utils/background'

export interface FittedImageProps {
  source: string
  /** 槽位的裁剪参数；缺省或为默认值时走 CSS cover */
  transform?: BackgroundTransform
  /** 附加在 <img> 上的类名（用于尺寸微调） */
  imgClassName?: string
  alt?: string
  onError?: () => void
}

interface Size {
  width: number
  height: number
}

function FittedImage({ source, transform, imgClassName, alt = '', onError }: FittedImageProps): ReactNode {
  const frameRef = useRef<HTMLSpanElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [frame, setFrame] = useState<Size>({ width: 0, height: 0 })
  const [natural, setNatural] = useState<Size | null>(null)

  const custom = !isDefaultTransform(transform)

  /**
   * 框架尺寸：必须用 ref 回调 + 自身持有 observer。
   * 不要用 useEffect(..., [])：设置是异步加载的，首帧可能还没渲染这个节点，
   * 那样 effect 首次拿到 null 之后就再也不会重跑（背景层踩过同样的坑）。
   */
  const attachFrame = useCallback((node: HTMLSpanElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    frameRef.current = node
    if (!node) return

    const measure = (): void => setFrame({ width: node.clientWidth, height: node.clientHeight })
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(node)
      observerRef.current = observer
    } else {
      window.addEventListener('resize', measure)
    }
  }, [])

  // 图片原始尺寸：data URL 可能在挂载前就 complete，onLoad 不会再触发，必须主动检查
  useLayoutEffect(() => {
    setNatural(null)
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
  }, [source])

  // 只有自定义裁剪才需要像素布局；算不出来（尺寸未知/参数异常）就退回 CSS cover
  const layout = custom && natural ? computeBackgroundLayout(frame, natural, transform) : null

  return (
    <span className="fit-frame" ref={attachFrame} data-mode={layout ? 'custom' : 'cover'}>
      <img
        ref={imageRef}
        key={source}
        className={['fit-img', imgClassName].filter(Boolean).join(' ')}
        src={source}
        alt={alt}
        referrerPolicy="no-referrer"
        draggable={false}
        data-custom={layout ? '1' : '0'}
        onError={onError}
        style={
          layout
            ? {
                left: `${layout.left}px`,
                top: `${layout.top}px`,
                width: `${layout.width}px`,
                height: `${layout.height}px`
              }
            : undefined
        }
      />
    </span>
  )
}

export default FittedImage
