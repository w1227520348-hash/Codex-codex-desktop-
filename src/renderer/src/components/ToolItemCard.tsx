import { memo } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import CommandCard from '@renderer/components/CommandCard'
import FileChangeCard from '@renderer/components/FileChangeCard'
import MessageBubble from '@renderer/components/MessageBubble'
import ReasoningBlock from '@renderer/components/ReasoningBlock'
import TodoCard from '@renderer/components/TodoCard'
import ToolCallCard from '@renderer/components/ToolCallCard'
import type { HarnessItem } from '@shared/types'
import { ITEM_STATUS_LABELS, ITEM_STATUS_TONES } from '@renderer/utils/format'

export interface ToolItemCardProps {
  item: HarnessItem
  onViewDiff?: (paths: string[], label: string) => void
}

/**
 * HarnessItem 判别联合的统一入口：switch (item.kind) 穷尽处理，未知分支有兜底。
 */
function ToolItemCardImpl({ item, onViewDiff }: ToolItemCardProps): ReactNode {
  switch (item.kind) {
    case 'agent_message':
      return (
        <MessageBubble
          role="assistant"
          text={item.text}
          streaming={item.status === 'in_progress'}
        />
      )

    case 'reasoning':
      return <ReasoningBlock item={item} />

    case 'command_execution':
      return <CommandCard item={item} />

    case 'file_change':
      return <FileChangeCard item={item} onViewDiff={onViewDiff} />

    case 'tool_call':
      return <ToolCallCard item={item} />

    case 'todo_list':
      return <TodoCard item={item} />

    case 'web_search':
      return (
        <div className="mini-card">
          <span className="mini-card-icon" aria-hidden="true">
            ⌕
          </span>
          <span className="mini-card-label">联网搜索</span>
          <span className="mini-card-text">{item.query}</span>
          <Badge tone={ITEM_STATUS_TONES[item.status]} pulse={item.status === 'in_progress'}>
            {ITEM_STATUS_LABELS[item.status]}
          </Badge>
        </div>
      )

    case 'compaction':
      return (
        <div className="mini-card">
          <span className="mini-card-icon" aria-hidden="true">
            ⌁
          </span>
          <span className="mini-card-label">上下文压缩</span>
          <span className="mini-card-text">旧对话已被摘要化，thread 继续沿用</span>
          <Badge tone={ITEM_STATUS_TONES[item.status]} pulse={item.status === 'in_progress'}>
            {ITEM_STATUS_LABELS[item.status]}
          </Badge>
        </div>
      )

    case 'error':
      return (
        <div className="notice notice-error">
          <span className="notice-icon" aria-hidden="true">
            ✕
          </span>
          <div className="notice-body">
            <div className="notice-title">执行出错</div>
            <div className="notice-text">{item.message}</div>
          </div>
        </div>
      )

    case 'unknown':
      return (
        <details className="tool-card tool-card-unknown">
          <summary className="tool-card-head">
            <span className="tool-card-icon" aria-hidden="true">
              ?
            </span>
            <span className="tool-card-title">
              <span className="tool-card-name">未识别条目</span>
            </span>
            <span className="tool-card-summary">原始类型：{item.rawType}</span>
            <Badge tone="neutral">原样展示</Badge>
          </summary>
          <div className="tool-card-body">
            <div className="notice-hint">该条目的原始数据：</div>
            <pre className="code-block">{safeStringify(item.raw)}</pre>
          </div>
        </details>
      )

    default:
      return null
  }
}

function safeStringify(value: unknown): string {
  try {
    const text: string | undefined = JSON.stringify(value, null, 2)
    return text ?? String(value)
  } catch {
    return String(value)
  }
}

const ToolItemCard = memo(ToolItemCardImpl)
export default ToolItemCard
