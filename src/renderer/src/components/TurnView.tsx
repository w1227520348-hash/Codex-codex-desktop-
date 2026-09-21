import { memo } from 'react'
import type { ReactNode } from 'react'
import MessageBubble from '@renderer/components/MessageBubble'
import ToolItemCard from '@renderer/components/ToolItemCard'
import { IconAttach } from '@renderer/components/icons'
import type { HarnessEvent, SessionTurn } from '@shared/types'
import { buildTurnRows } from '@renderer/utils/activity'
import { formatBytes, formatDuration, formatTokens } from '@renderer/utils/format'

export interface EventRowProps {
  event: HarnessEvent
}

/** 非条目型事件（notice / error / turn.failed / stderr / exit / turn.completed）的提示条 */
export function EventRow({ event }: EventRowProps): ReactNode {
  switch (event.type) {
    case 'notice': {
      const tone = event.level === 'denied' ? 'denied' : event.level === 'warn' ? 'warn' : 'info'
      const title = event.level === 'denied' ? '沙箱拒绝了该动作' : event.level === 'warn' ? '提示' : '信息'
      return (
        <div className={['notice', `notice-${tone}`].join(' ')}>
          <span className="notice-icon" aria-hidden="true">
            {event.level === 'denied' ? '⛔' : event.level === 'warn' ? '⚠' : 'ⓘ'}
          </span>
          <div className="notice-body">
            <div className="notice-title">{title}</div>
            <div className="notice-text">{event.message}</div>
          </div>
        </div>
      )
    }

    case 'error':
      return (
        <div className="notice notice-error">
          <span className="notice-icon" aria-hidden="true">
            ✕
          </span>
          <div className="notice-body">
            <div className="notice-title">{event.fatal ? '致命错误' : '出现错误'}</div>
            <div className="notice-text">{event.message}</div>
          </div>
        </div>
      )

    case 'turn.failed':
      return (
        <div className="notice notice-error">
          <span className="notice-icon" aria-hidden="true">
            ✕
          </span>
          <div className="notice-body">
            <div className="notice-title">本轮任务失败</div>
            <div className="notice-text">{event.message}</div>
          </div>
        </div>
      )

    case 'stderr':
      return (
        <details className="mini-card mini-card-stderr">
          <summary className="mini-card-summary">
            <span className="mini-card-label">stderr</span>
            <span className="mini-card-text">点开查看原始错误输出</span>
          </summary>
          <pre className="code-block">{event.text}</pre>
        </details>
      )

    case 'exit':
      return (
        <div className={['notice', event.code === 0 ? 'notice-info' : 'notice-warn'].join(' ')}>
          <span className="notice-icon" aria-hidden="true">
            ⏏
          </span>
          <div className="notice-body">
            <div className="notice-title">进程已退出</div>
            <div className="notice-text">
              code = {event.code === null ? 'null' : event.code} · signal = {event.signal ?? 'null'}
            </div>
          </div>
        </div>
      )

    case 'turn.completed': {
      const usage = formatTokens(event.usage)
      return (
        <div className="turn-meta">
          <span className="turn-meta-chip">本轮完成</span>
          {usage ? <span className="turn-meta-chip">Token：{usage}</span> : null}
        </div>
      )
    }

    default:
      return null
  }
}

export interface TurnViewProps {
  turn: SessionTurn
  running: boolean
  onViewDiff?: (paths: string[], label: string) => void
}

/** 一轮对话：用户气泡 + 按事件顺序渲染的 agent 输出 */
function TurnViewImpl({ turn, running, onViewDiff }: TurnViewProps): ReactNode {
  const rows = buildTurnRows(turn)
  const streaming = running && turn.status === 'running'
  const duration = turn.endedAt ? formatDuration(turn.endedAt - turn.startedAt) : null

  return (
    <section className="turn">
      {turn.prompt.trim() !== '' ? (
        <>
          <MessageBubble role="user" text={turn.prompt} time={turn.startedAt} />
          {turn.attachments && turn.attachments.length > 0 ? (
            <div className="turn-attachments">
              {turn.attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="attach-chip attach-chip-static"
                  data-ctx="attachment"
                  data-path={attachment.path}
                  data-name={attachment.name}
                  data-attachment-id={attachment.id}
                  title={`${attachment.path}${attachment.note ? `\n${attachment.note}` : ''}`}
                >
                  <span className="attach-chip-icon" aria-hidden="true">
                    <IconAttach size={12} />
                  </span>
                  <span className="attach-chip-name">{attachment.name}</span>
                  <span className="attach-chip-meta">{formatBytes(attachment.size)}</span>
                  <span
                    className={attachment.inlined ? 'attach-chip-tag' : 'attach-chip-tag attach-chip-tag-tool'}
                    title={attachment.note ?? (attachment.inlined ? '正文已内联进提示词' : '交给 Codex 用工具读取')}
                  >
                    {attachment.inlined ? '已内联' : '工具读取'}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="turn-system">
          <span className="turn-system-chip">引擎自动开始的一轮</span>
        </div>
      )}

      <div className="turn-body">
        {rows.length === 0 ? (
          <div className="turn-waiting">
            <span className="turn-waiting-dot" aria-hidden="true" />
            {streaming ? '已提交，等待引擎返回…' : '本轮没有记录到任何事件'}
          </div>
        ) : null}

        {rows.map((row) => {
          if (row.kind === 'item') {
            return <ToolItemCard key={row.key} item={row.item} onViewDiff={onViewDiff} />
          }
          const event = turn.events[row.eventIndex]
          // 行索引由 buildTurnRows 生成，理论上一定命中；兜底成不渲染
          return event ? <EventRow key={row.key} event={event} /> : null
        })}

        {streaming ? (
          <div className="turn-streaming">
            <span className="turn-streaming-bar" aria-hidden="true" />
            正在接收流式输出…
          </div>
        ) : null}
      </div>

      <div className="turn-footer">
        <span className={`turn-status turn-status-${turn.status}`}>
          {turn.status === 'running'
            ? '进行中'
            : turn.status === 'completed'
              ? '已完成'
              : turn.status === 'failed'
                ? '失败'
                : '已取消'}
        </span>
        {duration ? <span className="turn-footer-meta">耗时 {duration}</span> : null}
        <span className="turn-footer-meta">{new Date(turn.startedAt).toLocaleString('zh-CN')}</span>
      </div>
    </section>
  )
}

const TurnView = memo(TurnViewImpl)
export default TurnView
