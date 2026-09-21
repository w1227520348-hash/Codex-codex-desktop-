/**
 * 图片校验与压缩（零新依赖）。
 *
 * 设计要点：
 *  - **魔术字节**判定真实类型，不信扩展名（防止把 .exe 改名成 .png 混进来）
 *  - 用 canvas 重编码压缩：长边超过 MAX_EDGE 先等比缩放，再编码成 webp
 *  - GIF 特殊处理：canvas 重编码会丢掉动画，所以只要能塞进配额就原样保留
 *  - 压缩后反而更大时回退原图（小图重编码经常变大）
 */

import {
  IMAGE_MAX_STORED_BYTES,
  IMAGE_MAX_UPLOAD_BYTES,
  type AppearanceSettings
} from '@shared/types'

/** 允许的图片类型 */
export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] as const

/** 压缩时的长边上限 */
const MAX_EDGE = 2560
/** webp 编码质量 */
const WEBP_QUALITY = 0.82

export type ValidationResult = { ok: true; mime: string } | { ok: false; reason: string }

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

/** 通过魔术字节识别图片类型；识别不出返回 null */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'image/png'
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  return null
}

/** 校验上传文件：类型（魔术字节）+ 大小 */
export async function validateFile(file: File): Promise<ValidationResult> {
  if (file.size === 0) return { ok: false, reason: '这个文件是空的。' }
  if (file.size > IMAGE_MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `图片太大（${formatBytes(file.size)}），上限是 ${formatBytes(IMAGE_MAX_UPLOAD_BYTES)}。请先压缩或换一张。`
    }
  }

  let head: Uint8Array
  try {
    head = new Uint8Array(await file.slice(0, 32).arrayBuffer())
  } catch {
    return { ok: false, reason: '读取文件失败，请重试。' }
  }

  const mime = sniffMime(head)
  if (!mime) {
    return { ok: false, reason: `无法识别为图片（只支持 jpg / png / webp / gif / avif）。文件内容不像图片，即使扩展名是图片我也不会接受。` }
  }
  if (!(ACCEPTED_MIME as readonly string[]).includes(mime)) {
    return { ok: false, reason: `不支持的图片格式：${mime}` }
  }
  return { ok: true, mime }
}

/** 校验粘贴的图片地址：只允许 http/https */
export function validateRemoteUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: '请先粘贴一个图片地址。' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: '这不是一个合法的网址。' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `只接受 http/https 地址，拒绝 ${parsed.protocol}（出于安全考虑）。` }
  }
  return { ok: true, url: parsed.toString() }
}

/** data:URL 的实际字节数（base64 部分 × 3/4） */
export function estimateBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return dataUrl.length
  const payload = dataUrl.length - comma - 1
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return Math.max(0, Math.round((payload * 3) / 4) - padding)
}

/** 统计所有自定义图片占用（用于配额提示） */
export function totalCustomBytes(appearance: AppearanceSettings): number {
  let total = appearance.background?.bytes ?? 0
  for (const image of Object.values(appearance.slots)) {
    if (image) total += image.bytes
  }
  return total
}

export interface PreparedImage {
  dataUrl: string
  width: number
  height: number
  bytes: number
  /** 是否原样保留了文件（未重编码），GIF 保留动画时会为 true */
  preservedOriginal: boolean
  /** 给用户看的说明 */
  note?: string
}

async function loadImage(file: File): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close: () => void }> {
  // 优先用 createImageBitmap：不经 objectURL，省一次内存拷贝
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
        close: () => bitmap.close()
      }
    } catch {
      /* 退回到 objectURL 方案 */
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('图片解码失败'))
      element.src = url
    })
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(image, 0, 0, w, h),
      close: () => URL.revokeObjectURL(url)
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 把上传的文件准备成可存储的 data:URL。
 * 返回的 note 会直接展示给用户，说明做了什么取舍。
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const validation = await validateFile(file)
  if (!validation.ok) throw new Error(validation.reason)

  const originalDataUrl = await readAsDataUrl(file)
  const originalBytes = estimateBytes(originalDataUrl)

  // GIF：canvas 重编码会丢动画，能塞进配额就原样留
  if (validation.mime === 'image/gif' && originalBytes <= IMAGE_MAX_STORED_BYTES) {
    const size = await measure(file)
    return {
      dataUrl: originalDataUrl,
      width: size.width,
      height: size.height,
      bytes: originalBytes,
      preservedOriginal: true,
      note: 'GIF 已原样保留（重编码会丢失动画）。'
    }
  }

  const decoded = await loadImage(file)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前环境不支持 canvas，无法压缩图片')
    decoded.draw(ctx, width, height)

    const compressed = canvas.toDataURL('image/webp', WEBP_QUALITY)
    const compressedBytes = estimateBytes(compressed)

    // 小图重编码常常更大；原图还塞得下就用原图
    if (compressedBytes >= originalBytes && originalBytes <= IMAGE_MAX_STORED_BYTES) {
      return {
        dataUrl: originalDataUrl,
        width: decoded.width,
        height: decoded.height,
        bytes: originalBytes,
        preservedOriginal: true,
        note: '压缩后反而更大，已保留原图。'
      }
    }

    const oversized = compressedBytes > IMAGE_MAX_STORED_BYTES
    return {
      dataUrl: compressed,
      width,
      height,
      bytes: compressedBytes,
      preservedOriginal: false,
      note: oversized
        ? `压缩后仍有 ${formatBytes(compressedBytes)}，偏大，建议换一张更小的图。`
        : scale < 1
          ? `已压缩并缩放到 ${width}×${height}。`
          : '已压缩。'
    }
  } finally {
    decoded.close()
  }
}

async function measure(file: File): Promise<{ width: number; height: number }> {
  const decoded = await loadImage(file)
  try {
    return { width: decoded.width, height: decoded.height }
  } finally {
    decoded.close()
  }
}

/** 试探一个图片地址能否加载（用于保存远程 URL 前的预检） */
export function probeImage(source: string, timeoutMs = 12000): Promise<boolean> {
  return new Promise((resolve) => {
    const element = new Image()
    element.referrerPolicy = 'no-referrer'
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    element.onload = () => finish(true)
    element.onerror = () => finish(false)
    element.src = source
  })
}

/** 给远程图片统一加上 no-referrer，避免把本地地址泄露给图床 */
export const IMAGE_REFERRER_POLICY = 'no-referrer' as const
