import { memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { StatusDot } from '@renderer/components/Badge'
import type { ActivityEntry, ActivityFilter } from '@renderer/utils/activity'
import { ACTIVITY_FILTER_LABELS, filterActivity } from '@renderer/utils/activity'
import {
  basename,
  formatClock,
  ITEM_STATUS_LABELS,
  ITEM_STATUS_TONES
} from '@renderer/utils/format'
import type { BadgeTone } from '@renderer/utils/format'

export interface ActivityStreamProps {
  entries: ActivityEntry[]
  filter: ActivityFilter
  onFilterChange: (filter: ActivityFilter) => void
  onSelect?: (entry: ActivityEntry) => void
  running: boolean
}

const FILTERS: ActivityFilter[] = ['all', 'command', 'file', 'problem']

/** 右侧「活动流」标签页：所有工具调用按时间顺序聚合，带状态点、耗时、工具名 */
function ActivityStreamImpl({
  entries,
  filter,
  onFilterChange,
  onSelect,
  running
}: ActivityStreamProps): ReactNode {
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const visible = filterActivity(entries, filter)
  const lastSeq = visible.length > 0 ? visible[visible.length - 1]?.seq : -1

  return (
    <div className="activity">
      <div className="activity-filters">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item}
            className={['chip', filter === item ? 'chip-active' : ''].filter(Boolean).join(' ')}
            onClick={() => onFilterChange(item)}
          >
            {ACTIVITY_FILTER_LABELS[item]}
          </button>
        ))}
        <span className="activity-count">{visible.length} 条</span>
      </div>

      {visible.length === 0 ? (
        <div className="panel-empty">
          <div className="panel-empty-title">还没有工具活动</div>
          <p>任务开始后，这里会按时间顺序列出每一次命令、文件变更与错误。</p>
        </div>
      ) : (
        <ol className="activity-list">
          {visible.map((entry) => (
            <li key={`${entry.variant}-${entry.turnId}-${entry.seq}`}>
              <ActivityRow
                entry={entry}
                now={now}
                isLatest={entry.seq === lastSeq}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ActivityRow({
  entry,
  now,
  isLatest,
  onSelect
}: {
  entry: ActivityEntry
  now: number
  isLatest: boolean
  onSelect?: (entry: ActivityEntry) => void
}): ReactNode {
  if (entry.variant === 'diagnosis') {
    const tone: BadgeTone = entry.level === 'error' ? 'danger' : entry.level === 'denied' ? 'denied' : entry.level === 'warn' ? 'warn' : 'info'
    return (
      <div className={['activity-row', 'activity-row-diagnosis', `activity-row-${entry.level}`].join(' ')}>
        <StatusDot tone={tone} pulse={isLatest && entry.level === 'denied'} />
        <div className="activity-main">
          <div className="activity-head">
            <span className="activity-tool">{entry.label}</span>
            <span className="activity-time">{formatClock(now)}</span>
          </div>
          <div className={['activity-title', `activity-title-${entry.level}`].join(' ')}>{entry.message}</div>
        </div>
      </div>
    )
  }

  const item = entry.item
  const active = entry.status === 'in_progress'
  const tone = ITEM_STATUS_TONES[entry.status]
  const meta = itemMeta(entry)

  return (
    <button type="button" className="activity-row" onClick={() => onSelect?.(entry)}>
      <StatusDot tone={tone} pulse={active} />
      <div className="activity-main">
        <div className="activity-head">
          <span className="activity-tool">{entry.label}</span>
          <span className={['activity-status', `activity-status-${entry.status}`].join(' ')}>
            {ITEM_STATUS_LABELS[entry.status]}
          </span>
          <span className="activity-time">{formatClock(now)}</span>
        </div>
        <div className="activity-title">{entry.title}</div>
        {meta ? <div className="activity-meta">{meta}</div> : null}
      </div>
      {item.kind === 'file_change' ? <span className="activity-hint">点击查看</span> : null}
    </button>
  )
}

/** 每个条目右侧的补充信息：行数统计 / 退出码 / 文件数 */
function itemMeta(entry: Extract<ActivityEntry, { variant: 'item' }>): string | null {
  const item = entry.item
  switch (item.kind) {
    case 'command_execution': {
      const lines = item.output === '' ? 0 : item.output.split(/\r?\n/).length
      const parts = [`${lines} 行输出`]
      if (item.exitCode !== null) parts.push(`退出码 ${item.exitCode}`)
      if (item.status !== 'in_progress' && item.status !== 'unknown') parts.push(item.status === 'completed' ? '成功' : '未成功')
      return parts.join(' · ')
    }
    case 'file_change':
      return item.changes.map((change) => basename(change.path)).join('、')
    case 'tool_call': {
      const lines = item.output === '' ? 0 : item.output.split(/\r?\n/).length
      return `${lines} 行输出`
    }
    case 'web_search':
      return null
    case 'todo_list':
      return item.items.map((todo) => (todo.completed ? `✓ ${todo.text}` : `○ ${todo.text}`)).join('  ')
    case 'error':
      return '执行错误'
    case 'unknown':
      return `原始类型 ${item.rawType}`
    case 'agent_message':
    case 'reasoning':
      return null
    default:
      return null
  }
}

export default memo(ActivityStreamImpl)
