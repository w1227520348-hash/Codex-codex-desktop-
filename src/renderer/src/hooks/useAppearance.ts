/**
 * 个性化外观的应用层。
 *
 * 职责：
 *  1. 把外观设置落成 `<html>` 上的标记与 CSS 变量
 *     —— 没有背景时 data-has-bg 不存在，背景相关样式都不生效
 *  2. 解析背景来源（自定义图优先，其次内置壁纸）与其编辑参数
 *  3. 解析各图片槽位：有自定义图就用，加载失败则**回退默认**并记录原因
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_TRANSFORM,
  type AppearanceSettings,
  type BackgroundTransform,
  type ImageSlotId,
  type StylePreset
} from '@shared/types'
import { sanitizeTransform } from '@renderer/utils/background'
import { wallpaperSource } from '@renderer/utils/wallpapers'

/** 槽位加载失败集合（只存在内存里，不持久化） */
export type FailedSlots = Partial<Record<ImageSlotId, string>>

export interface AppearanceRuntime {
  appearance: AppearanceSettings
  /** 取某槽位应该渲染的图片地址；null = 用程序自带默认 */
  slotSource: (id: ImageSlotId) => string | null
  markSlotFailed: (id: ImageSlotId, reason?: string) => void
  failedSlots: FailedSlots

  /** 生效的背景图地址；null = 无背景 */
  backgroundSource: string | null
  /** 已净化的编辑参数 */
  backgroundTransform: BackgroundTransform
  /** 背景是否为用户自定义图（false 且 source 非空 = 内置壁纸） */
  backgroundIsCustom: boolean
  /** 背景加载失败时调用：整块背景退回默认（不显示） */
  markBackgroundFailed: (reason?: string) => void
  backgroundFailure: string | null

  hasBackground: boolean
  stylePreset: StylePreset
}

function applyToDocument(appearance: AppearanceSettings, hasBackground: boolean): void {
  const root = document.documentElement

  // 背景的可视参数（图片本身由 BackgroundLayer 精确定位，不用 CSS background-image）
  root.style.setProperty('--app-bg-overlay', String(appearance.backgroundOverlay))
  root.style.setProperty('--app-bg-blur', `${appearance.backgroundBlur}px`)
  if (hasBackground) root.setAttribute('data-has-bg', '1')
  else root.removeAttribute('data-has-bg')

  root.setAttribute('data-avatars', appearance.showAvatars ? 'on' : 'off')
  root.setAttribute('data-style', appearance.stylePreset)
}

export function useAppearance(appearance: AppearanceSettings | undefined): AppearanceRuntime {
  const resolved = appearance ?? DEFAULT_APPEARANCE
  const [failedSlots, setFailedSlots] = useState<FailedSlots>({})
  const [backgroundFailure, setBackgroundFailure] = useState<string | null>(null)

  // 背景来源：自定义图优先，其次内置壁纸
  const customSource = resolved.background?.source ?? null
  const builtinSource = resolved.wallpaper ? wallpaperSource(resolved.wallpaper) : null
  const rawSource = customSource ?? builtinSource
  const backgroundSource = backgroundFailure ? null : rawSource

  const backgroundTransform = useMemo(
    () => sanitizeTransform(resolved.background?.transform ?? DEFAULT_TRANSFORM),
    [resolved.background?.transform]
  )

  const hasBackground = Boolean(backgroundSource)

  useEffect(() => {
    applyToDocument(resolved, hasBackground)
  }, [
    hasBackground,
    resolved.backgroundOverlay,
    resolved.backgroundBlur,
    resolved.showAvatars,
    resolved.stylePreset
  ])

  // 换了背景图就清掉失败记录，给新图一次机会
  useEffect(() => {
    setBackgroundFailure(null)
  }, [rawSource])

  // 槽位换了图就把失败记录清掉
  const slotSignature = useMemo(
    () =>
      Object.entries(resolved.slots)
        .map(([key, value]) => `${key}:${value?.source.length ?? 0}:${value?.addedAt ?? 0}`)
        .join('|'),
    [resolved.slots]
  )
  useEffect(() => {
    setFailedSlots({})
  }, [slotSignature])

  const markSlotFailed = useCallback((id: ImageSlotId, reason?: string): void => {
    setFailedSlots((previous) => {
      if (previous[id]) return previous
      return { ...previous, [id]: reason ?? '图片加载失败，已回退到默认图' }
    })
  }, [])

  const markBackgroundFailed = useCallback((reason?: string): void => {
    setBackgroundFailure(reason ?? '背景图加载失败，已回退到无背景')
  }, [])

  const slotSource = useCallback(
    (id: ImageSlotId): string | null => {
      if (failedSlots[id]) return null
      return resolved.slots[id]?.source ?? null
    },
    [resolved.slots, failedSlots]
  )

  return {
    appearance: resolved,
    slotSource,
    markSlotFailed,
    failedSlots,
    backgroundSource,
    backgroundTransform,
    backgroundIsCustom: Boolean(customSource) && !backgroundFailure,
    markBackgroundFailed,
    backgroundFailure,
    hasBackground,
    stylePreset: resolved.stylePreset
  }
}

/**
 * 用 context 传给深层的展示组件（侧栏 Logo、空状态插图、消息头像），
 * 避免把 slotSource 一路透传到 TurnView / MessageBubble。
 */
export const AppearanceContext = createContext<AppearanceRuntime | null>(null)

export function useAppearanceRuntime(): AppearanceRuntime {
  const runtime = useContext(AppearanceContext)
  // 没挂 Provider 时给一个安全的空实现，组件照常渲染默认图
  return (
    runtime ?? {
      appearance: DEFAULT_APPEARANCE,
      slotSource: () => null,
      markSlotFailed: () => undefined,
      failedSlots: {},
      backgroundSource: null,
      backgroundTransform: DEFAULT_TRANSFORM,
      backgroundIsCustom: false,
      markBackgroundFailed: () => undefined,
      backgroundFailure: null,
      hasBackground: false,
      stylePreset: 'anime'
    }
  )
}

/** 单个槽位的便捷读取：返回可直接绑到 <img> 的属性 */
export function useSlotImage(id: ImageSlotId): {
  src: string | null
  onError: () => void
  referrerPolicy: 'no-referrer'
} {
  const runtime = useAppearanceRuntime()
  const src = runtime.slotSource(id)
  return {
    src,
    onError: useCallback(() => runtime.markSlotFailed(id), [runtime, id]),
    referrerPolicy: 'no-referrer'
  }
}
