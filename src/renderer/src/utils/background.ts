/**
 * 背景图的布局计算（纯函数，可在 Node 里单测）。
 *
 * 设计：不用 `background-size`，而是把背景当成一个被精确定位的 <img>。
 * 这样才能同时支持「缩放 / 平移 / 框选」，而且天然不会拉伸变形。
 *
 * 坐标系约定：
 *  - crop 用图片归一化坐标（0~1）表示「只显示哪一块」
 *  - offset 用容器尺寸的比例表示平移量
 *
 * 退化保护：任何一步算出非有限值（NaN / Infinity）就返回 null，
 * 调用方据此回退到「自适应铺满」，避免参数坏了整块背景消失。
 */

import type { BackgroundTransform } from '@shared/types'

export interface Size {
  width: number
  height: number
}

export interface BackgroundLayout {
  /** 相对容器左上角的像素位置与尺寸 */
  left: number
  top: number
  width: number
  height: number
  /** 实际生效的缩放系数（图片像素 → 容器像素） */
  scale: number
}

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 3

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** 归一化一份 transform，非法值一律回到默认 */
export function sanitizeTransform(raw: BackgroundTransform | undefined | null): BackgroundTransform {
  if (!raw || typeof raw !== 'object') return { zoom: 1, offsetX: 0, offsetY: 0, crop: null }
  const zoom = Number.isFinite(raw.zoom) ? clamp(raw.zoom, MIN_ZOOM, MAX_ZOOM) : 1
  const offsetX = Number.isFinite(raw.offsetX) ? clamp(raw.offsetX, -2, 2) : 0
  const offsetY = Number.isFinite(raw.offsetY) ? clamp(raw.offsetY, -2, 2) : 0

  let crop: BackgroundTransform['crop'] = null
  const c = raw.crop
  if (c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.w) && Number.isFinite(c.h)) {
    const x = clamp(c.x, 0, 1)
    const y = clamp(c.y, 0, 1)
    const w = clamp(c.w, 0.02, 1 - x)
    const h = clamp(c.h, 0.02, 1 - y)
    if (w > 0.02 && h > 0.02) crop = { x, y, w, h }
  }
  return { zoom, offsetX, offsetY, crop }
}

/**
 * 计算背景图应该摆在哪、多大。
 * 返回 null 表示当前参数不可用，应回退到自适应铺满。
 */
export function computeBackgroundLayout(
  container: Size,
  image: Size,
  transform: BackgroundTransform | undefined | null
): BackgroundLayout | null {
  if (!container || !image) return null
  const CW = container.width
  const CH = container.height
  const IW = image.width
  const IH = image.height
  // 容器或图片尺寸还没量到（0 / NaN）时不算，交给调用方回退
  if (!(CW > 0) || !(CH > 0) || !(IW > 0) || !(IH > 0)) return null

  const { zoom, offsetX, offsetY, crop } = sanitizeTransform(transform)

  // 要显示的源区域（图片像素）
  const sx = crop ? crop.x * IW : 0
  const sy = crop ? crop.y * IH : 0
  const sw = crop ? crop.w * IW : IW
  const sh = crop ? crop.h * IH : IH
  if (!(sw > 0) || !(sh > 0)) return null

  // 让源区域「铺满」容器：取两个方向所需比例的较大者 → cover，永不拉伸
  const baseScale = Math.max(CW / sw, CH / sh)
  const scale = baseScale * zoom
  if (!Number.isFinite(scale) || scale <= 0) return null

  const width = IW * scale
  const height = IH * scale

  // 把源区域中心对齐到容器中心，再叠加用户平移
  const sourceCenterX = sx + sw / 2
  const sourceCenterY = sy + sh / 2
  const left = CW / 2 - sourceCenterX * scale + offsetX * CW
  const top = CH / 2 - sourceCenterY * scale + offsetY * CH

  if (![left, top, width, height, scale].every((value) => Number.isFinite(value))) return null
  if (!(width > 0) || !(height > 0)) return null

  return { left, top, width, height, scale }
}

/** 把 drag 的像素位移换算成 offset 比例（用于拖拽平移） */
export function pixelDeltaToOffset(dx: number, dy: number, container: Size): { offsetX: number; offsetY: number } {
  const w = container.width > 0 ? container.width : 1
  const h = container.height > 0 ? container.height : 1
  return { offsetX: dx / w, offsetY: dy / h }
}

/** 生成给 <img> 用的内联样式；layout 为 null 时用 CSS object-fit 兜底（极少数异常情况） */
export function layoutToStyle(layout: BackgroundLayout | null): Record<string, string> {
  if (!layout) return {}
  return {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    width: `${layout.width}px`,
    height: `${layout.height}px`
  }
}

/** 判断一份 transform 是否为「默认自适应」 */
export function isDefaultTransform(transform: BackgroundTransform | undefined | null): boolean {
  const t = sanitizeTransform(transform)
  return t.zoom === 1 && t.offsetX === 0 && t.offsetY === 0 && t.crop === null
}
