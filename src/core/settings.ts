/**
 * 本地配置读写。API Key 只存在 ~/.codex-desktop/config.json，**不写进任何代码/仓库**。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_APPEARANCE, DEFAULT_SETTINGS, IMAGE_SLOTS } from '../shared/types'
import { portableDataDir } from './appPaths'
import type { AppearanceSettings, AppSettings, BackgroundTransform, BuiltinWallpaperId, CustomImage, StylePreset } from '../shared/types'

/**
 * 应用数据目录，优先级：
 *   1. 环境变量 CODEX_DESKTOP_HOME（测试 / 自动化用）
 *   2. **便携模式**：应用根目录存在 portable.flag → <root>/data（整个文件夹拷走即带走配置）
 *   3. 默认 ~/.codex-desktop
 *
 * 注意不要用改 USERPROFILE 的方式做隔离：实测那样会让 Electron 直接起不来。
 */
function resolveAppDir(): string {
  const override = process.env.CODEX_DESKTOP_HOME
  if (override && override.trim().length > 0) return path.resolve(override.trim())
  const portable = portableDataDir()
  if (portable) return portable
  return path.join(os.homedir(), '.codex-desktop')
}

export const APP_DIR = resolveAppDir()
export const SETTINGS_FILE = path.join(APP_DIR, 'config.json')
export const SESSIONS_DIR = path.join(APP_DIR, 'sessions')
export const CODEX_HOME_DIR = path.join(APP_DIR, 'codex-home')
export const USER_CODEX_HOME = path.join(os.homedir(), '.codex')

export function ensureAppDirs(): void {
  for (const dir of [APP_DIR, SESSIONS_DIR, CODEX_HOME_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/** 校验单张自定义图片：只接受 data:image/* 或 http(s) 地址，其它一律丢弃 */
function coerceImage(raw: unknown): CustomImage | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Partial<CustomImage>
  if (typeof input.source !== 'string' || input.source.length === 0) return null
  // 允许 svg+xml：内置壁纸就是内联 SVG data URL。
  // 注意 <img src="data:image/svg+xml,..."> 是「被动」文档，脚本不会执行，因此安全。
  const isData = /^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml)(;[^,;]*)?,/i.test(input.source)
  const isRemote = /^https?:\/\//i.test(input.source)
  if (!isData && !isRemote) return null

  const bytes =
    typeof input.bytes === 'number' && Number.isFinite(input.bytes) && input.bytes >= 0
      ? Math.floor(input.bytes)
      : Math.round(input.source.length * 0.75)

  return {
    source: input.source,
    kind: isData ? 'data' : 'remote',
    name: typeof input.name === 'string' && input.name.length > 0 ? input.name : undefined,
    bytes,
    width: typeof input.width === 'number' && Number.isFinite(input.width) ? Math.floor(input.width) : undefined,
    height: typeof input.height === 'number' && Number.isFinite(input.height) ? Math.floor(input.height) : undefined,
    addedAt: typeof input.addedAt === 'number' && Number.isFinite(input.addedAt) ? input.addedAt : Date.now(),
    transform: coerceTransform(input.transform)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 净化背景编辑参数。
 * 任何一项非法（NaN / 越界 / 宽高为零）都退回默认的自适应铺满，
 * 避免「参数坏了导致背景整块不显示」。
 */
export function coerceTransform(raw: unknown): BackgroundTransform | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<BackgroundTransform>

  const zoom = typeof input.zoom === 'number' && Number.isFinite(input.zoom) ? clamp(input.zoom, 0.5, 3) : 1
  const offsetX = typeof input.offsetX === 'number' && Number.isFinite(input.offsetX) ? clamp(input.offsetX, -2, 2) : 0
  const offsetY = typeof input.offsetY === 'number' && Number.isFinite(input.offsetY) ? clamp(input.offsetY, -2, 2) : 0

  let crop: BackgroundTransform['crop'] = null
  const rawCrop = input.crop as Partial<NonNullable<BackgroundTransform['crop']>> | null | undefined
  if (rawCrop && typeof rawCrop === 'object') {
    const x = typeof rawCrop.x === 'number' && Number.isFinite(rawCrop.x) ? rawCrop.x : null
    const y = typeof rawCrop.y === 'number' && Number.isFinite(rawCrop.y) ? rawCrop.y : null
    const w = typeof rawCrop.w === 'number' && Number.isFinite(rawCrop.w) ? rawCrop.w : null
    const h = typeof rawCrop.h === 'number' && Number.isFinite(rawCrop.h) ? rawCrop.h : null
    // 只有四个值都合法、宽高有意义、且与整图有区别时才保留
    if (x !== null && y !== null && w !== null && h !== null && w > 0.02 && h > 0.02) {
      const cx = clamp(x, 0, 1)
      const cy = clamp(y, 0, 1)
      const cw = clamp(w, 0.02, 1 - cx)
      const ch = clamp(h, 0.02, 1 - cy)
      if (cw > 0.02 && ch > 0.02) crop = { x: cx, y: cy, w: cw, h: ch }
    }
  }

  // 全默认（整图 + 无缩放 + 无位移）就存 undefined，让配置更干净
  if (zoom === 1 && offsetX === 0 && offsetY === 0 && crop === null) return undefined
  return { zoom, offsetX, offsetY, crop }
}

function coerceAppearance(raw: unknown): AppearanceSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppearanceSettings>
  const out: AppearanceSettings = { ...DEFAULT_APPEARANCE, slots: {} }

  const background = coerceImage(input.background)
  if (background) out.background = background

  if (typeof input.backgroundOverlay === 'number' && Number.isFinite(input.backgroundOverlay)) {
    out.backgroundOverlay = clamp(input.backgroundOverlay, 0, 0.9)
  }
  if (typeof input.backgroundBlur === 'number' && Number.isFinite(input.backgroundBlur)) {
    out.backgroundBlur = clamp(input.backgroundBlur, 0, 24)
  }
  if (typeof input.showAvatars === 'boolean') out.showAvatars = input.showAvatars
  if (input.stylePreset === 'anime' || input.stylePreset === 'classic') {
    out.stylePreset = input.stylePreset as StylePreset
  }
  if (input.wallpaper === 'starry' || input.wallpaper === 'sakura' || input.wallpaper === 'clouds') {
    out.wallpaper = input.wallpaper as BuiltinWallpaperId
  }

  // 只保留已知槽位，避免旧版本/脏数据留下无法渲染的键
  if (input.slots && typeof input.slots === 'object') {
    const rawSlots = input.slots as Record<string, unknown>
    for (const meta of IMAGE_SLOTS) {
      const image = coerceImage(rawSlots[meta.id])
      if (image) out.slots[meta.id] = image
    }
  }
  return out
}

function coerce(raw: unknown): AppSettings {  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  const merged: AppSettings = { ...DEFAULT_SETTINGS }

  if (typeof input.apiKey === 'string') merged.apiKey = input.apiKey.trim()
  if (typeof input.model === 'string' && input.model.trim()) merged.model = input.model.trim()
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    merged.temperature = Math.min(2, Math.max(0, input.temperature))
  }
  if (typeof input.baseUrl === 'string' && input.baseUrl.trim()) {
    merged.baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  }
  if (typeof input.reuseUserCodexConfig === 'boolean') merged.reuseUserCodexConfig = input.reuseUserCodexConfig
  if (typeof input.useNativeResponses === 'boolean') merged.useNativeResponses = input.useNativeResponses
  if (input.permissionMode === 'read-only' || input.permissionMode === 'workspace-write' || input.permissionMode === 'danger-full-access') {
    merged.permissionMode = input.permissionMode
  }
  if (input.theme === 'light' || input.theme === 'dark' || input.theme === 'system') merged.theme = input.theme
  if (input.engine === 'app-server' || input.engine === 'exec') merged.engine = input.engine
  if (typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens >= 0) {
    merged.maxOutputTokens = Math.floor(input.maxOutputTokens)
  }
  if (typeof input.modelContextWindow === 'number' && Number.isFinite(input.modelContextWindow) && input.modelContextWindow >= 1024) {
    merged.modelContextWindow = Math.floor(input.modelContextWindow)
  }
  if (typeof input.autoCompactLimit === 'number' && Number.isFinite(input.autoCompactLimit) && input.autoCompactLimit >= 0) {
    merged.autoCompactLimit = Math.floor(input.autoCompactLimit)
  }
  if (Array.isArray(input.recentWorkspaces)) {
    merged.recentWorkspaces = input.recentWorkspaces.filter((w): w is string => typeof w === 'string').slice(0, 12)
  }
  merged.appearance = coerceAppearance(input.appearance)
  return merged
}

export function loadSettings(): AppSettings {
  ensureAppDirs()
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
    return coerce(JSON.parse(raw))
  } catch (error) {
    console.error('[settings] 读取配置失败，使用默认值：', error)
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  ensureAppDirs()
  const current = loadSettings()
  const next = coerce({ ...current, ...patch })
  const tmp = `${SETTINGS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, SETTINGS_FILE)
  return next
}

/** 把某个工作区记入最近使用列表 */
export function rememberWorkspace(workspace: string): AppSettings {
  const current = loadSettings()
  const list = [workspace, ...current.recentWorkspaces.filter((w) => w !== workspace)].slice(0, 12)
  return saveSettings({ recentWorkspaces: list })
}
