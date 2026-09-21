import { memo } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import Markdown from '@renderer/components/Markdown'
import type { HarnessItem } from '@shared/types'
import { itemSummary, ITEM_STATUS_LABELS, ITEM_STATUS_TONES } from '@renderer/utils/format'

export interface ToolCallCardProps {
  item: Extract<HarnessItem, { kind: 'tool_call' }>
  defaultOpen?: boolean
}

function ToolCallCardImpl({ item, defaultOpen = false }: ToolCallCardProps): ReactNode {
  const active = item.status === 'in_progress'

  return (
    <details className={['tool-card', active ? 'tool-card-active' : ''].filter(Boolean).join(' ')} open={defaultOpen}>
      <summary className="tool-card-head">
        <span className="tool-card-icon" aria-hidden="true">
          ⚙
        </span>
        <span className="tool-card-title">
          {item.server ? <span className="tool-card-server">{item.server} / </span> : null}
          <span className="tool-card-name">{item.tool}</span>
        </span>
        <span className="tool-card-summary">{itemSummary(item)}</span>
        <Badge tone={ITEM_STATUS_TONES[item.status]} pulse={active}>
          {ITEM_STATUS_LABELS[item.status]}
        </Badge>
      </summary>

      <div className="tool-card-body">
        {item.arguments.trim() !== '' ? (
          <div className="tool-card-section">
            <div className="tool-card-label">参数</div>
            <pre className="code-block">{item.arguments}</pre>
          </div>
        ) : null}

        {item.output.trim() !== '' ? (
          <div className="tool-card-section">
            <div className="tool-card-label">输出</div>
            <div className="tool-card-markdown">
              <Markdown source={item.output} />
            </div>
          </div>
        ) : (
          <div className="tool-card-empty">{active ? '等待工具返回…' : '该工具没有输出'}</div>
        )}
      </div>
    </details>
  )
}

const ToolCallCard = memo(ToolCallCardImpl)
export default ToolCallCard
