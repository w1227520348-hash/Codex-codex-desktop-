/**
 * 背景编辑弹窗：缩放 / 平移 / 框选。
 *
 * 两个预览区各司其职，避免把三件事挤在一个视图里互相干扰：
 *  - 左：**框选范围** —— 显示整张图，拖四角改选区、拖选区内移动选区（人影/图标/场景都能锁定）
 *  - 右：**位置与缩放** —— 所见即所得的目标画面，拖拽平移、滑块缩放
 *
 * 所有调整都实时回传（onPreview），点「保存」才落盘；「重置」回到自适应铺满。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconClose, IconRefresh } from '@renderer/components/icons'
import type { BackgroundTransform } from '@shared/types'
import {
  computeBackgroundLayout,
  isDefaultTransform,
  MAX_ZOOM,
  MIN_ZOOM,
  pixelDeltaToOffset,
  sanitizeTransform
} from '@renderer/utils/background'

export interface BackgroundEditorProps {
  open: boolean
  source: string | null
  transform: BackgroundTransform | undefined
  onClose: () => void
  onPreview: (transform: BackgroundTransform) => void
  /** 保存并返回是否成功 */
  onSave: (transform: BackgroundTransform) => Promise<void>
  /** 取景框宽高比：背景用视口比例，头像/图标用 1（正方） */
  aspect?: number
  /** 取景框遮罩形状：头像用 circle，看起来就是最终裁切效果 */
  mask?: 'rect' | 'circle'
  /** 弹窗标题 */
  title?: string
  /** 副标题说明 */
  subtitle?: string
}

interface Size {
  width: number
  height: number
}

type DragMode = 'move-crop' | 'nw' | 'ne' | 'sw' | 'se' | 'pan'

interface DragState {
  mode: DragMode
  startX: number
  startY: number
  crop: NonNullable<BackgroundTransform['crop']>
  offsetX: number
  offsetY: number
  box: Size
}

const MIN_CROP = 0.05
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function BackgroundEditor({
  open,
  source,
  transform,
  onClose,
  onPreview,
  onSave,
  aspect = 16 / 9,
  mask = 'rect',
  title = '背景编辑',
  subtitle = '调整缩放、位置与显示区域。改动实时预览，点「保存」生效。'
}: BackgroundEditorProps): ReactNode {
  const [draft, setDraft] = useState<BackgroundTransform>(sanitizeTransform(transform))
  const [natural, setNatural] = useState<Size | null>(null)
  const [cropBox, setCropBox] = useState<Size>({ width: 0, height: 0 })
  const [frameBox, setFrameBox] = useState<Size>({ width: 0, height: 0 })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cropBoxRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const cropImageRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<DragState | null>(null)

  // 打开时同步外部值。
  // ⚠️ 依赖里只能有 open：transform 会随着我们自己的 onPreview 不断变化，
  // 若把它放进依赖，每次拖拽都会把草稿重置回去、并把已量到的图片尺寸清空。
  const latestTransform = useRef(transform)
  latestTransform.current = transform
  useEffect(() => {
    if (open) {
      setDraft(sanitizeTransform(latestTransform.current))
      setError(null)
      setNatural(null)
    }
  }, [open])

  /** 改草稿 + 实时预览 */
  const update = useCallback(
    (next: BackgroundTransform): void => {
      setDraft(next)
      onPreview(next)
    },
    [onPreview]
  )

  // 量两个预览区的尺寸（窗口变化时跟随）
  useEffect(() => {
    if (!open) return
    const observe = (element: HTMLElement | null, setter: (size: Size) => void): (() => void) | undefined => {
      if (!element) return undefined
      const measure = (): void => setter({ width: element.clientWidth, height: element.clientHeight })
      measure()
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const a = observe(cropBoxRef.current, setCropBox)
    const b = observe(frameRef.current, setFrameBox)
    return () => {
      a?.()
      b?.()
    }
  }, [open])

  // 量图片原始尺寸：同样不能用 onLoad —— data URL 可能在挂载前就 complete，
  // 那样选区框永远不出来。这里主动检查 complete，未完成才监听 load。
  useLayoutEffect(() => {
    const element = cropImageRef.current
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
  }, [source, open])

  // 框选区在「整图预览」里的位置（contain 适配）
  const fit = ((): { scale: number; dispW: number; dispH: number; dispX: number; dispY: number } | null => {
    if (!natural || cropBox.width <= 0 || cropBox.height <= 0) return null
    const scale = Math.min(cropBox.width / natural.width, cropBox.height / natural.height)
    const dispW = natural.width * scale
    const dispH = natural.height * scale
    return {
      scale,
      dispW,
      dispH,
      dispX: (cropBox.width - dispW) / 2,
      dispY: (cropBox.height - dispH) / 2
    }
  })()

  const crop = draft.crop ?? { x: 0, y: 0, w: 1, h: 1 }

  /* ---------------- 拖拽 ---------------- */
  const beginDrag = useCallback(
    (mode: DragMode, event: React.PointerEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const box = mode === 'pan' ? frameBox : cropBox
      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        crop: { ...crop },
        offsetX: draft.offsetX,
        offsetY: draft.offsetY,
        box
      }
      ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    [crop, draft.offsetX, draft.offsetY, cropBox, frameBox]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY

      if (drag.mode === 'pan') {
        const { offsetX, offsetY } = pixelDeltaToOffset(dx, dy, drag.box)
        update({
          ...draft,
          offsetX: clamp(drag.offsetX + offsetX, -2, 2),
          offsetY: clamp(drag.offsetY + offsetY, -2, 2)
        })
        return
      }

      if (drag.box.width <= 0 || drag.box.height <= 0) return
      // 像素 → 图片归一化
      const nx = dx / drag.box.width
      const ny = dy / drag.box.height

      if (drag.mode === 'move-crop') {
        update({
          ...draft,
          crop: {
            ...drag.crop,
            x: clamp(drag.crop.x + nx, 0, 1 - drag.crop.w),
            y: clamp(drag.crop.y + ny, 0, 1 - drag.crop.h)
          }
        })
        return
      }

      // 四角缩放：先算新的四边，再规范化成 x/y/w/h
      let left = drag.crop.x
      let top = drag.crop.y
      let right = drag.crop.x + drag.crop.w
      let bottom = drag.crop.y + drag.crop.h
      if (drag.mode === 'nw' || drag.mode === 'sw') left = clamp(drag.crop.x + nx, 0, right - MIN_CROP)
      if (drag.mode === 'ne' || drag.mode === 'se') right = clamp(right + nx, left + MIN_CROP, 1)
      if (drag.mode === 'nw' || drag.mode === 'ne') top = clamp(drag.crop.y + ny, 0, bottom - MIN_CROP)
      if (drag.mode === 'sw' || drag.mode === 'se') bottom = clamp(bottom + ny, top + MIN_CROP, 1)

      update({ ...draft, crop: { x: left, y: top, w: right - left, h: bottom - top } })
    },
    [draft, update]
  )

  const endDrag = useCallback((): void => {
    dragRef.current = null
  }, [])

  /* ---------------- 右侧所见即所得 ---------------- */
  const frameLayout = natural ? computeBackgroundLayout(frameBox, natural, draft) : null

  const reset = useCallback((): void => {
    update({ zoom: 1, offsetX: 0, offsetY: 0, crop: null })
  }, [update])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSave(isDefaultTransform(draft) ? { zoom: 1, offsetX: 0, offsetY: 0, crop: null } : draft)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [draft, onSave, onClose])

  if (!open) return null

  return (
    <div className="bg-editor-root" role="dialog" aria-modal="true" aria-label="背景编辑">
      <button type="button" className="bg-editor-scrim" aria-label="关闭背景编辑" onClick={onClose} />

      <div className="bg-editor">
        <header className="bg-editor-head">
          <div>
            <h2 className="bg-editor-title">{title}</h2>
            <p className="bg-editor-subtitle">{subtitle}</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        {error ? (
          <div className="notice notice-error">
            <span className="notice-icon" aria-hidden="true">
              ✕
            </span>
            <div className="notice-body">
              <div className="notice-text">{error}</div>
            </div>
          </div>
        ) : null}

        <div className="bg-editor-grid">
          {/* 框选范围 */}
          <section className="bg-editor-pane">
            <div className="bg-editor-pane-head">
              <span className="bg-editor-pane-title">框选范围</span>
              <span className="field-hint">拖四角改大小，拖选区内部移动</span>
            </div>
            <div
              className="bg-crop-box"
              ref={cropBoxRef}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {source ? (
                <img
                  className="bg-crop-image"
                  ref={cropImageRef}
                  key={source}
                  src={source}
                  alt=""
                  referrerPolicy="no-referrer"
                  draggable={false}
                  onError={() => setError('图片加载失败，无法编辑。')}
                />
              ) : null}

              {fit ? (
                <div
                  className="bg-crop-rect"
                  style={{
                    left: `${fit.dispX + crop.x * fit.dispW}px`,
                    top: `${fit.dispY + crop.y * fit.dispH}px`,
                    width: `${crop.w * fit.dispW}px`,
                    height: `${crop.h * fit.dispH}px`
                  }}
                  onPointerDown={(event) => beginDrag('move-crop', event)}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                    <span
                      key={corner}
                      className={`bg-crop-handle bg-crop-handle-${corner}`}
                      onPointerDown={(event) => beginDrag(corner, event)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
            <div className="bg-editor-readout">
              选区 x={crop.x.toFixed(2)} y={crop.y.toFixed(2)} w={crop.w.toFixed(2)} h={crop.h.toFixed(2)}
            </div>
          </section>

          {/* 位置与缩放 */}
          <section className="bg-editor-pane">
            <div className="bg-editor-pane-head">
              <span className="bg-editor-pane-title">位置与缩放</span>
              <span className="field-hint">在框内拖拽平移</span>
            </div>
            <div
              className={['bg-frame', mask === 'circle' ? 'bg-frame-circle' : ''].filter(Boolean).join(' ')}
              ref={frameRef}
              style={{ aspectRatio: String(aspect) }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerDown={(event) => beginDrag('pan', event)}
            >
              {source && frameLayout ? (
                <img
                  className="bg-frame-img"
                  src={source}
                  alt=""
                  referrerPolicy="no-referrer"
                  draggable={false}
                  style={{
                    left: `${frameLayout.left}px`,
                    top: `${frameLayout.top}px`,
                    width: `${frameLayout.width}px`,
                    height: `${frameLayout.height}px`
                  }}
                />
              ) : (
                <span className="bg-frame-empty">等待图片…</span>
              )}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="bg-zoom">
                缩放：{Math.round(draft.zoom * 100)}%
              </label>
              <input
                id="bg-zoom"
                className="range bg-zoom"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                value={draft.zoom}
                onChange={(event) => update({ ...draft, zoom: Number(event.target.value) })}
              />
            </div>
            <div className="bg-editor-readout">
              平移 offsetX={draft.offsetX.toFixed(3)} offsetY={draft.offsetY.toFixed(3)}
            </div>
          </section>
        </div>

        <footer className="bg-editor-foot">
          <button type="button" className="button button-ghost" onClick={reset} disabled={saving}>
            <IconRefresh size={13} />
            重置为自适应铺满
          </button>
          <div className="drawer-foot-right">
            <button type="button" className="button button-ghost" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default BackgroundEditor
