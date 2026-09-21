/**
 * 个性化设置抽屉（右侧）。
 *
 * 交互约定：
 *  - 面板内的任何修改都会**立即预览**（onPreview → App 把草稿当作生效值渲染）
 *  - 「保存」才落盘；「取消」回滚到已保存的状态
 *  - 「全部恢复默认」把草稿清空并预览，仍需保存才持久化
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import { IconClose, IconFolder, IconRefresh } from '@renderer/components/icons'
import {
  BUILTIN_WALLPAPERS,
  DEFAULT_APPEARANCE,
  IMAGE_MAX_UPLOAD_BYTES,
  IMAGE_SLOTS,
  IMAGE_TOTAL_WARN_BYTES,
  type AppearanceSettings,
  type BuiltinWallpaperId,
  type CustomImage,
  type ImageSlotId,
  type StylePreset
} from '@shared/types'
import { formatBytes, prepareImage, probeImage, totalCustomBytes, validateRemoteUrl } from '@renderer/utils/image'
import { wallpaperThumb } from '@renderer/utils/wallpapers'

const STYLE_OPTIONS: { value: StylePreset; label: string; hint: string }[] = [
  { value: 'anime', label: '二次元', hint: '糖果色 + 毛玻璃 + 圆润控件' },
  { value: 'classic', label: '经典', hint: '原来的工程感冷色配色' }
]

export interface PersonalizationDrawerProps {
  open: boolean
  /** 已保存的外观设置 */
  appearance: AppearanceSettings
  onClose: () => void
  /** 实时预览（不落盘） */
  onPreview: (draft: AppearanceSettings) => void
  /** 保存并应用 */
  onSave: (draft: AppearanceSettings) => Promise<void>
  /** 打开背景编辑弹窗 */
  onEditBackground: () => void
  /** 打开某个槽位（头像/图标/Logo）的裁剪弹窗 */
  onEditSlot: (id: ImageSlotId) => void
}

/** 正在等待输入 URL 的目标：背景或某个槽位 */
type UrlTarget = { kind: 'background' } | { kind: 'slot'; id: ImageSlotId }

function toCustomImage(source: string, kind: 'data' | 'remote', extra: Partial<CustomImage> = {}): CustomImage {
  return {
    source,
    kind,
    bytes: extra.bytes ?? Math.round(source.length * 0.75),
    width: extra.width,
    height: extra.height,
    name: extra.name,
    addedAt: Date.now()
  }
}

function PersonalizationDrawer({
  open,
  appearance,
  onClose,
  onPreview,
  onSave,
  onEditBackground,
  onEditSlot
}: PersonalizationDrawerProps): ReactNode {
  const [draft, setDraft] = useState<AppearanceSettings>(appearance)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [urlTarget, setUrlTarget] = useState<UrlTarget | null>(null)
  const [urlValue, setUrlValue] = useState('')
  const [busy, setBusy] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadTargetRef = useRef<UrlTarget | null>(null)

  // 打开时同步已保存值；关闭时清理提示
  useEffect(() => {
    if (open) {
      setDraft(appearance)
      setError(null)
      setNotice(null)
      setUrlTarget(null)
      setUrlValue('')
    }
  }, [open, appearance])

  /** 改草稿 + 立即预览 */
  const update = useCallback(
    (patch: Partial<AppearanceSettings>): void => {
      setDraft((previous) => {
        const next = { ...previous, ...patch }
        onPreview(next)
        return next
      })
    },
    [onPreview]
  )

  const totalBytes = useMemo(() => totalCustomBytes(draft), [draft])
  const overQuota = totalBytes > IMAGE_TOTAL_WARN_BYTES

  const pickFile = useCallback((target: UrlTarget): void => {
    uploadTargetRef.current = target
    setUrlTarget(null)
    const input = fileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }, [])

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      const target = uploadTargetRef.current
      if (!target) return
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const prepared = await prepareImage(file)
        const image = toCustomImage(prepared.dataUrl, 'data', {
          bytes: prepared.bytes,
          width: prepared.width,
          height: prepared.height,
          name: file.name
        })
        if (target.kind === 'background') update({ background: image })
        else update({ slots: { ...draft.slots, [target.id]: image } })
        setNotice(
          `${file.name}：${prepared.note ?? '已应用'} 约 ${formatBytes(prepared.bytes)}${
            prepared.bytes > IMAGE_MAX_UPLOAD_BYTES ? '（偏大）' : ''
          }`
        )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
        uploadTargetRef.current = null
      }
    },
    [draft.slots, update]
  )

  const submitUrl = useCallback(async (): Promise<void> => {
    if (!urlTarget) return
    const validated = validateRemoteUrl(urlValue)
    if (!validated.ok) {
      setError(validated.reason)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const reachable = await probeImage(validated.url)
      if (!reachable) {
        setError('这个地址加载不出图片（可能失效、需要登录，或被网络拦截）。已取消应用。')
        return
      }
      const image = toCustomImage(validated.url, 'remote')
      if (urlTarget.kind === 'background') update({ background: image })
      else update({ slots: { ...draft.slots, [urlTarget.id]: image } })
      setNotice('远程图片已应用。注意：每次显示都会从该主机拉取图片。')
      setUrlTarget(null)
      setUrlValue('')
    } finally {
      setBusy(false)
    }
  }, [urlTarget, urlValue, draft.slots, update])

  const clearBackground = useCallback((): void => {
    update({ background: null })
    setNotice('已恢复默认背景（无自定义背景）。')
    setError(null)
  }, [update])

  const clearSlot = useCallback(
    (id: ImageSlotId): void => {
      const nextSlots = { ...draft.slots }
      delete nextSlots[id]
      update({ slots: nextSlots })
      setNotice('该槽位已恢复默认。')
      setError(null)
    },
    [draft.slots, update]
  )

  /** 只清掉裁剪参数，保留图片本身 —— 对应「重置为默认裁剪」 */
  const resetSlotTransform = useCallback(
    (id: ImageSlotId): void => {
      const current = draft.slots[id]
      if (!current) return
      update({ slots: { ...draft.slots, [id]: { ...current, transform: undefined } } })
      setNotice('该槽位的裁剪已重置为默认（cover 居中）。')
      setError(null)
    },
    [draft.slots, update]
  )

  const resetAll = useCallback((): void => {
    const fresh: AppearanceSettings = { ...DEFAULT_APPEARANCE, slots: {} }
    setDraft(fresh)
    onPreview(fresh)
    setNotice('已全部恢复默认，点「保存」才会写入。')
    setError(null)
  }, [onPreview])

  const cancel = useCallback((): void => {
    onPreview(appearance) // 回滚预览
    onClose()
  }, [appearance, onPreview, onClose])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [draft, onSave, onClose])

  if (!open) return null

  const renderImageActions = (target: UrlTarget, current: CustomImage | null | undefined): ReactNode => (
    <div className="inline-row">
      <button type="button" className="button button-ghost button-sm" onClick={() => pickFile(target)} disabled={busy}>
        <IconFolder size={13} />
        上传图片
      </button>
      <button
        type="button"
        className="button button-ghost button-sm"
        disabled={busy}
        onClick={() => {
          setUrlTarget(target)
          setUrlValue('')
          setError(null)
        }}
      >
        粘贴 URL
      </button>
      {current ? (
        <button
          type="button"
          className="button button-ghost button-sm"
          disabled={busy}
          onClick={() => (target.kind === 'background' ? clearBackground() : clearSlot(target.id))}
        >
          <IconRefresh size={13} />
          恢复默认
        </button>
      ) : null}
    </div>
  )

  const renderUrlInput = (target: UrlTarget): ReactNode => {
    const isActive =
      urlTarget !== null &&
      urlTarget.kind === target.kind &&
      (target.kind === 'background' || (urlTarget.kind === 'slot' && urlTarget.id === target.id))
    if (!isActive) return null
    return (
      <div className="drawer-url">
        <input
          className="input"
          type="url"
          placeholder="https://example.com/background.jpg"
          value={urlValue}
          onChange={(event) => setUrlValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitUrl()
            if (event.key === 'Escape') setUrlTarget(null)
          }}
          autoFocus
        />
        <button type="button" className="button button-primary button-sm" onClick={() => void submitUrl()} disabled={busy}>
          {busy ? '检测中…' : '应用'}
        </button>
        <button type="button" className="button button-ghost button-sm" onClick={() => setUrlTarget(null)}>
          放弃
        </button>
      </div>
    )
  }

  return (
    <div className="drawer-root" role="dialog" aria-modal="false" aria-label="个性化设置">
      <button type="button" className="drawer-scrim" aria-label="关闭个性化设置" onClick={cancel} />

      <aside className="drawer">
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title">个性化设置</h2>
            <p className="drawer-subtitle">背景图与程序内图片的替换。改动会立即预览，点「保存」才写入配置。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={cancel}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="drawer-body">
          {error ? (
            <div className="notice notice-error">
              <span className="notice-icon" aria-hidden="true">
                ✕
              </span>
              <div className="notice-body">
                <div className="notice-title">无法应用</div>
                <div className="notice-text">{error}</div>
              </div>
            </div>
          ) : null}

          {notice ? (
            <div className="notice notice-info">
              <span className="notice-icon" aria-hidden="true">
                ⓘ
              </span>
              <div className="notice-body">
                <div className="notice-text">{notice}</div>
              </div>
            </div>
          ) : null}

          {overQuota ? (
            <div className="notice notice-warn">
              <span className="notice-icon" aria-hidden="true">
                ⚠
              </span>
              <div className="notice-body">
                <div className="notice-title">自定义图片总量偏大</div>
                <div className="notice-text">
                  当前约 {formatBytes(totalBytes)}，超过建议上限 {formatBytes(IMAGE_TOTAL_WARN_BYTES)}
                  。配置会明显变大，建议替换掉其中一张。
                </div>
              </div>
            </div>
          ) : null}

          {/* ---------------- 视觉风格 ---------------- */}
          <section className="drawer-section">
            <div className="drawer-section-head">
              <h3 className="drawer-section-title">视觉风格</h3>
              <Badge tone="info">{STYLE_OPTIONS.find((o) => o.value === draft.stylePreset)?.label ?? '二次元'}</Badge>
            </div>
            <div className="segmented">
              {STYLE_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={['segment', draft.stylePreset === option.value ? 'segment-active' : ''].filter(Boolean).join(' ')}
                  title={option.hint}
                  onClick={() => update({ stylePreset: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="field-hint">
              只影响框架层（面板、控件、圆角、配色）。代码块与终端始终保持高对比，不参与萌化。
            </div>
          </section>

          {/* ---------------- 背景 ---------------- */}
          <section className="drawer-section">
            <div className="drawer-section-head">
              <h3 className="drawer-section-title">全屏背景</h3>
              {draft.background ? (
                <Badge tone="info">自定义图片</Badge>
              ) : draft.wallpaper ? (
                <Badge tone="info">内置壁纸</Badge>
              ) : (
                <Badge tone="neutral">默认</Badge>
              )}
            </div>
            <div className="field-hint">
              会铺满整个窗口。与下面的头像/图标是**两套独立设置**，互不影响。
            </div>

            {/* 内置壁纸 */}
            <div className="field-label">内置壁纸</div>
            <div className="wallpaper-grid">
              {BUILTIN_WALLPAPERS.map((wallpaper) => {
                const active = !draft.background && draft.wallpaper === wallpaper.id
                return (
                  <button
                    type="button"
                    key={wallpaper.id}
                    className={['wallpaper-item', active ? 'wallpaper-item-active' : ''].filter(Boolean).join(' ')}
                    title={wallpaper.hint}
                    onClick={() => update({ wallpaper: wallpaper.id, background: null })}
                  >
                    <img className="wallpaper-thumb" src={wallpaperThumb(wallpaper.id)} alt={wallpaper.label} />
                    <span className="wallpaper-label">{wallpaper.label}</span>
                  </button>
                )
              })}
            </div>
            <div className="inline-row">
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => update({ wallpaper: null })}
                disabled={!draft.wallpaper}
              >
                不使用壁纸
              </button>
            </div>

            <div className="drawer-preview">
              {draft.background ? (
                <img
                  className="drawer-thumb drawer-thumb-wide"
                  src={draft.background.source}
                  alt="背景预览"
                  referrerPolicy="no-referrer"
                />
              ) : draft.wallpaper ? (
                <img
                  className="drawer-thumb drawer-thumb-wide"
                  src={wallpaperThumb(draft.wallpaper as BuiltinWallpaperId)}
                  alt="壁纸预览"
                />
              ) : (
                <div className="drawer-thumb drawer-thumb-wide drawer-thumb-empty">无背景</div>
              )}
            </div>

            {renderImageActions({ kind: 'background' }, draft.background)}
            {renderUrlInput({ kind: 'background' })}

            <div className="inline-row">
              <button
                type="button"
                className="button button-ghost button-sm"
                disabled={!draft.background && !draft.wallpaper}
                title={
                  draft.background
                    ? '缩放 / 平移 / 框选背景图'
                    : draft.wallpaper
                      ? '会把内置壁纸转成可编辑副本，再进入编辑'
                      : '先上传图片、粘贴 URL 或选择内置壁纸'
                }
                onClick={() => {
                  // 内置壁纸没有自己的图片对象；点编辑时先复制成自定义背景，之后就能带 transform
                  if (!draft.background && draft.wallpaper) {
                    const src = wallpaperThumb(draft.wallpaper)
                    update({
                      background: {
                        source: src,
                        kind: 'data',
                        bytes: Math.round(src.length * 0.75),
                        addedAt: Date.now()
                      },
                      wallpaper: null
                    })
                  }
                  onEditBackground()
                }}
              >
                编辑背景（缩放 / 位置 / 框选）
              </button>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="bg-overlay">
                遮罩强度：{Math.round(draft.backgroundOverlay * 100)}%（越大文字越清晰）
              </label>
              <input
                id="bg-overlay"
                className="range"
                type="range"
                min={0}
                max={0.9}
                step={0.02}
                value={draft.backgroundOverlay}
                onChange={(event) => update({ backgroundOverlay: Number(event.target.value) })}
              />
            </div>

            <div className="field">
              <label className="field-label" htmlFor="bg-blur">
                背景模糊：{draft.backgroundBlur}px
              </label>
              <input
                id="bg-blur"
                className="range"
                type="range"
                min={0}
                max={24}
                step={1}
                value={draft.backgroundBlur}
                onChange={(event) => update({ backgroundBlur: Number(event.target.value) })}
              />
            </div>
          </section>

          {/* ---------------- 默认图片 ---------------- */}
          <section className="drawer-section">
            <div className="drawer-section-head">
              <h3 className="drawer-section-title">头像与图标</h3>
              <span className="field-hint">
                已替换 {Object.keys(draft.slots).length} / {IMAGE_SLOTS.length}
              </span>
            </div>
            <div className="field-hint">
              只填充各自的框架（头像框 / 图标框），**不会**变成全屏背景：按框架尺寸 cover 居中裁切，
              不拉伸、不溢出，圆形框会自动裁成圆形。每个槽位可单独「裁剪 / 调整」。
            </div>

            <label className="option option-check">
              <input
                type="checkbox"
                checked={draft.showAvatars}
                onChange={(event) => update({ showAvatars: event.target.checked })}
              />
              <span className="option-main">
                <span className="option-label">显示对话区头像</span>
                <span className="option-hint">关掉后对话区回到纯气泡样式（头像槽位也随之隐藏）。</span>
              </span>
            </label>

            {IMAGE_SLOTS.map((meta) => {
              const current = draft.slots[meta.id]
              const disabled = (meta.id === 'userAvatar' || meta.id === 'assistantAvatar') && !draft.showAvatars
              return (
                <div className={['drawer-slot', current ? 'drawer-slot-active' : ''].filter(Boolean).join(' ')} key={meta.id}>
                  <div className="drawer-slot-head">
                    <span className="drawer-slot-label">
                      {meta.label}
                      {meta.added ? <Badge tone="neutral">新增</Badge> : null}
                    </span>
                    {current ? <Badge tone="info">已替换</Badge> : <Badge tone="neutral">默认</Badge>}
                  </div>
                  <div className="drawer-slot-hint">{meta.hint}</div>

                  <div className="drawer-slot-body">
                    {current ? (
                      <img
                        className="drawer-thumb drawer-thumb-slot"
                        src={current.source}
                        alt={`${meta.label}预览`}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="drawer-thumb drawer-thumb-slot drawer-thumb-empty">默认</div>
                    )}
                    {disabled ? (
                      <span className="field-hint">已关闭头像显示，该槽位当前不生效。</span>
                    ) : null}
                  </div>

                  {renderImageActions({ kind: 'slot', id: meta.id }, current)}
                  {renderUrlInput({ kind: 'slot', id: meta.id })}

                  {current ? (
                    <div className="inline-row">
                      <button
                        type="button"
                        className="button button-ghost button-sm"
                        disabled={busy}
                        title="缩放 / 平移 / 框选：只影响这个槽位，图片始终被裁在框架内"
                        onClick={() => onEditSlot(meta.id)}
                      >
                        裁剪 / 调整
                      </button>
                      {current.transform ? (
                        <button
                          type="button"
                          className="button button-ghost button-sm"
                          disabled={busy}
                          title="清掉缩放与框选，回到 cover 居中"
                          onClick={() => resetSlotTransform(meta.id)}
                        >
                          重置为默认裁剪
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}

            <p className="field-hint">
              图标类元素（终端、文件、齿轮等 20 个内联图标）不支持逐个替换：它们带尺寸与配色语义，替换成位图会破坏视觉一致性。
            </p>
          </section>
        </div>

        <footer className="drawer-foot">
          <button type="button" className="button button-ghost" onClick={resetAll} disabled={saving}>
            全部恢复默认
          </button>
          <div className="drawer-foot-right">
            <button type="button" className="button button-ghost" onClick={cancel} disabled={saving}>
              取消
            </button>
            <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving || busy}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </footer>

        {/* 隐藏的文件选择器，被所有「上传图片」按钮复用 */}
        <input
          ref={fileInputRef}
          className="hidden-file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void handleFile(file)
          }}
        />
      </aside>
    </div>
  )
}

export default PersonalizationDrawer
