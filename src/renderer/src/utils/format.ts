import type {
  HarnessItem,
  PermissionMode,
  TokenUsage,
  ToolItemStatus
} from '@shared/types'
import { PERMISSION_MODE_LABELS } from '@shared/types'

/* ------------------------------------------------------------------ *
 * 时间 / 体积格式化
 * ------------------------------------------------------------------ */

export function formatClock(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '--:--:--'
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天给日期 */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - timestamp)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days <= 30) return `${days} 天前`
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 毫秒 → 1:23 / 1:02:03 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${minutes}:${pad(seconds)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex] ?? 'KB'}`
}

/** 路径末段，兼容 Windows 反斜杠 */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.length > 0 ? (parts[parts.length - 1] ?? path) : path
}

/** 3 行以内的路径展示用 */
export function shortenPath(path: string, keep: number = 3): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter((part) => part !== '')
  if (parts.length <= keep) return normalized
  return `…/${parts.slice(-keep).join('/')}`
}

/** 单行截断，用于卡片标题 */
export function oneLine(text: string, max: number = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

/**
 * 紧凑数字：状态栏徽章用。
 * formatTokens 是给「输入 X · 输出 Y」这种明细用的，只喂一个总数时它会出现
 * 「合计 624」这种字样，放进「上下文 合计 624 / 合计 62259」读起来很别扭；
 * 状态栏空间又窄，所以这里单独给一个短的写法。
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '?'
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  if (abs < 1_000_000) {
    const k = value / 1000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`
  }
  const m = value / 1_000_000
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`
}

export function formatTokens(usage: TokenUsage | undefined): string | null {
  if (!usage) return null
  const parts: string[] = []
  if (typeof usage.inputTokens === 'number') parts.push(`输入 ${usage.inputTokens}`)
  if (typeof usage.outputTokens === 'number') parts.push(`输出 ${usage.outputTokens}`)
  if (typeof usage.cachedInputTokens === 'number' && usage.cachedInputTokens > 0) {
    parts.push(`缓存命中 ${usage.cachedInputTokens}`)
  }
  if (parts.length === 0 && typeof usage.totalTokens === 'number') parts.push(`合计 ${usage.totalTokens}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/* ------------------------------------------------------------------ *
 * 状态徽章
 * ------------------------------------------------------------------ */

export type BadgeTone = 'neutral' | 'running' | 'success' | 'danger' | 'warn' | 'info' | 'denied'

export const ITEM_STATUS_LABELS: Record<ToolItemStatus, string> = {
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  denied: '被拒绝',
  unknown: '未知'
}

export const ITEM_STATUS_TONES: Record<ToolItemStatus, BadgeTone> = {
  in_progress: 'running',
  completed: 'success',
  failed: 'danger',
  denied: 'denied',
  unknown: 'neutral'
}

export const SESSION_STATUS_TEXT: Record<'running' | 'completed' | 'failed' | 'cancelled', string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export const SESSION_STATUS_TONES: Record<'running' | 'completed' | 'failed' | 'cancelled', BadgeTone> = {
  running: 'running',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warn'
}

export const PERMISSION_BADGE_TEXT: Record<PermissionMode, string> = PERMISSION_MODE_LABELS

/** 文件变更类型 → 中文标签与色调 */
export function fileKindMeta(kind: string): { label: string; tone: BadgeTone } {
  switch (kind) {
    case 'add':
    case 'added':
    case 'create':
      return { label: '新增', tone: 'success' }
    case 'delete':
    case 'deleted':
    case 'remove':
      return { label: '删除', tone: 'danger' }
    case 'update':
    case 'updated':
    case 'modify':
      return { label: '修改', tone: 'info' }
    default:
      return { label: kind === '' ? '变更' : kind, tone: 'neutral' }
  }
}

/* ------------------------------------------------------------------ *
 * 条目摘要
 * ------------------------------------------------------------------ */

/** 工具卡片的一行简述 */
export function itemSummary(item: HarnessItem): string {
  switch (item.kind) {
    case 'agent_message':
      return oneLine(item.text, 160)
    case 'reasoning':
      return oneLine(item.text, 160)
    case 'command_execution':
      return oneLine(item.command, 160)
    case 'file_change':
      return item.changes.length > 0
        ? item.changes.map((change) => `${basename(change.path)}（${fileKindMeta(change.kind).label}）`).join('、')
        : '文件变更'
    case 'tool_call':
      return item.server ? `${item.server} / ${item.tool}` : item.tool
    case 'todo_list':
      return `${item.items.filter((entry) => entry.completed).length}/${item.items.length} 项已完成`
    case 'web_search':
      return oneLine(item.query, 160)
    case 'compaction':
      return '上下文已压缩（旧对话被摘要化，thread 继续沿用）'
    case 'error':
      return oneLine(item.message, 160)
    case 'unknown':
      return `未识别的条目类型：${item.rawType}`
    default:
      return '未知条目'
  }
}

/** 当前活动流里展示用的「工具名」 */
export function itemToolName(item: HarnessItem): string {
  switch (item.kind) {
    case 'command_execution':
      return 'exec_command'
    case 'file_change':
      return '文件变更'
    case 'tool_call':
      return item.tool
    case 'web_search':
      return 'web_search'
    case 'todo_list':
      return 'todo_list'
    case 'reasoning':
      return '思考'
    case 'agent_message':
      return '回复'
    case 'compaction':
      return '上下文压缩'
    case 'error':
      return '错误'
    case 'unknown':
      return item.rawType
    default:
      return '未知'
  }
}

/** 带 status 字段的条目子集（error / todo_list / unknown 之外的全部） */
type StatusItem = Extract<HarnessItem, { status: ToolItemStatus }>

/** 取条目状态，让调用方不必再处理判别联合里缺字段的分支 */
export function itemStatus(item: HarnessItem): ToolItemStatus {
  switch (item.kind) {
    case 'agent_message':
    case 'reasoning':
    case 'command_execution':
    case 'file_change':
    case 'tool_call':
    case 'web_search': {
      const withStatus: StatusItem = item
      return withStatus.status
    }
    case 'todo_list':
      return 'completed'
    case 'error':
      return 'failed'
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

export function isActiveItem(item: HarnessItem): boolean {
  if (item.kind === 'error' || item.kind === 'unknown') return false
  return itemStatus(item) === 'in_progress'
}
