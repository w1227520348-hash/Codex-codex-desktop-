import type { HarnessEvent, HarnessItem, SessionDetail, SessionTurn, ToolItemStatus } from '@shared/types'
import { basename, itemStatus, itemToolName, oneLine } from '@renderer/utils/format'

/**
 * 渲染层的会话视图模型 + 活动流投影。
 * 纯数据，不含 React 依赖，方便单独推演流式合并逻辑。
 */

export interface SessionView {
  /** 会话详情；null 表示仅创建了会话、还没载入过详情 */
  detail: SessionDetail | null
  loaded: boolean
}

export type TurnStatus = SessionTurn['status']

export type DiagnosisLevel = 'info' | 'warn' | 'denied' | 'error'

/** 活动流里的一条工具活动 */
export interface ActivityItemEntry {
  variant: 'item'
  item: HarnessItem
  turnIndex: number
  turnId: string
  label: string
  title: string
  status: ToolItemStatus
  /** 递增序号，用来做稳定的 React key 与「最新」判断 */
  seq: number
}

/** 活动流里的桥/引擎诊断（权限被拒、错误、stderr、退出） */
export interface ActivityDiagnosisEntry {
  variant: 'diagnosis'
  level: DiagnosisLevel
  message: string
  turnIndex: number
  turnId: string
  label: string
  title: string
  seq: number
}

export type ActivityEntry = ActivityItemEntry | ActivityDiagnosisEntry

/** 对话区需要按顺序渲染的一行 */
export type ConversationRow =
  | { kind: 'item'; key: string; item: HarnessItem }
  | { kind: 'event'; key: string; turnId: string; eventIndex: number }

/** 把一轮里的事件折叠成「按条目合并」的渲染行 */
export function buildTurnRows(turn: SessionTurn): ConversationRow[] {
  const rows: ConversationRow[] = []
  const indexById = new Map<string, number>()

  turn.events.forEach((event, eventIndex) => {
    switch (event.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const existing = indexById.get(event.item.id)
        if (typeof existing === 'number') {
          // 就地更新同一条目，绝不重复插入
          rows[existing] = { kind: 'item', key: event.item.id, item: event.item }
        } else {
          indexById.set(event.item.id, rows.length)
          rows.push({ kind: 'item', key: event.item.id, item: event.item })
        }
        break
      }
      case 'error':
      case 'turn.failed':
      case 'notice':
      case 'stderr':
      case 'exit':
      case 'turn.completed':
      case 'thread.started':
      case 'turn.started': {
        rows.push({ kind: 'event', key: `${turn.id}-ev-${eventIndex}`, turnId: turn.id, eventIndex })
        break
      }
      default:
        break
    }
  })

  return rows
}

function itemSummaryText(item: HarnessItem): string {
  switch (item.kind) {
    case 'command_execution':
      return item.command
    case 'file_change':
      return item.changes.map((change) => basename(change.path)).join('、') || '文件变更'
    case 'tool_call':
      return item.server ? `${item.server} / ${item.tool}` : item.tool
    case 'web_search':
      return item.query
    case 'todo_list':
      return `${item.items.length} 项待办`
    case 'error':
      return item.message
    case 'unknown':
      return item.rawType
    case 'agent_message':
    case 'reasoning':
      return oneLine(item.text, 120)
    default:
      return '未知条目'
  }
}

/** 诊断事件 → 活动流条目（不产生条目的返回 null） */
function diagnosisFromEvent(event: HarnessEvent): { level: DiagnosisLevel; message: string; label: string } | null {
  switch (event.type) {
    case 'notice':
      return { level: event.level, message: event.message, label: '提示' }
    case 'error':
      return { level: 'error', message: event.message, label: event.fatal ? '致命错误' : '错误' }
    case 'turn.failed':
      return { level: 'error', message: event.message, label: '轮次失败' }
    case 'stderr':
      return { level: 'warn', message: event.text, label: 'stderr' }
    case 'exit':
      return {
        level: event.code === 0 ? 'info' : 'warn',
        message: `进程退出：code=${event.code === null ? 'null' : event.code} signal=${event.signal ?? 'null'}`,
        label: '退出'
      }
    default:
      return null
  }
}

/** 从当前会话的所有轮次里挑出工具条目与诊断，按时间顺序聚合 */
export function collectActivity(turns: SessionTurn[]): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  let seq = 0

  turns.forEach((turn, turnIndex) => {
    const seen = new Map<string, number>()
    for (const event of turn.events) {
      if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        const item = event.item
        if (item.kind === 'agent_message' || item.kind === 'reasoning') continue
        seq += 1
        const existingIndex = seen.get(item.id)
        const entry: ActivityItemEntry = {
          variant: 'item',
          item,
          turnIndex,
          turnId: turn.id,
          label: itemToolName(item),
          title: oneLine(itemSummaryText(item), 120),
          status: itemStatus(item),
          seq
        }
        if (typeof existingIndex === 'number') {
          entries[existingIndex] = entry
        } else {
          seen.set(item.id, entries.length)
          entries.push(entry)
        }
        continue
      }

      const diagnosis = diagnosisFromEvent(event)
      if (diagnosis) {
        seq += 1
        entries.push({
          variant: 'diagnosis',
          level: diagnosis.level,
          message: diagnosis.message,
          turnIndex,
          turnId: turn.id,
          label: diagnosis.label,
          title: oneLine(diagnosis.message, 120),
          seq
        })
      }
    }
  })

  return entries
}

export type ActivityFilter = 'all' | 'command' | 'file' | 'problem'

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: '全部',
  command: '命令',
  file: '文件',
  problem: '异常'
}

export function filterActivity(entries: ActivityEntry[], filter: ActivityFilter): ActivityEntry[] {
  switch (filter) {
    case 'all':
      return entries
    case 'command':
      return entries.filter(
        (entry) =>
          entry.variant === 'item' &&
          (entry.item.kind === 'command_execution' || entry.item.kind === 'tool_call')
      )
    case 'file':
      return entries.filter((entry) => entry.variant === 'item' && entry.item.kind === 'file_change')
    case 'problem':
      return entries.filter((entry) => {
        if (entry.variant === 'diagnosis') return entry.level === 'error' || entry.level === 'denied'
        return (
          entry.item.kind === 'error' ||
          entry.item.kind === 'unknown' ||
          entry.status === 'failed' ||
          entry.status === 'denied'
        )
      })
    default:
      return entries
  }
}

/** 从最后一轮里找正在进行的工具名（RunStatus 没给值时兜底） */
export function guessCurrentTool(turns: SessionTurn[]): string | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]
    if (!turn) continue
    for (let eventIndex = turn.events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = turn.events[eventIndex]
      if (!event) continue
      if (event.type === 'item.started' || event.type === 'item.updated') {
        if (itemStatus(event.item) === 'in_progress') return itemToolName(event.item)
      }
    }
    break
  }
  return null
}
