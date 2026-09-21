import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import type { HarnessItem } from '@shared/types'
import { formatBytes, ITEM_STATUS_LABELS, ITEM_STATUS_TONES } from '@renderer/utils/format'

export interface CommandCardProps {
  item: Extract<HarnessItem, { kind: 'command_execution' }>
  defaultOpen?: boolean
}

/** 终端风格命令卡片：深色底、等宽字体、可滚动输出、退出码徽章 */
function CommandCardImpl({ item, defaultOpen = false }: CommandCardProps): ReactNode {
  const active = item.status === 'in_progress'
  const [expanded, setExpanded] = useState(defaultOpen || active)

  const exitTone = item.exitCode === null ? 'neutral' : item.exitCode === 0 ? 'success' : 'danger'
  const output = item.output ?? ''
  const lines = output === '' ? 0 : output.split(/\r?\n/).length

  return (
    <div className={['command-card', active ? 'command-card-active' : ''].filter(Boolean).join(' ')}>
      <div className="command-head">
        <span className="command-prompt" aria-hidden="true">
          $
        </span>
        <code className="command-text" data-ctx="command" data-ctx-text={item.command}>
          {item.command === '' ? '(空命令)' : item.command}
        </code>
        <span className="command-head-right">
          {item.exitCode !== null ? (
            <Badge tone={exitTone} title="退出码">
              退出码 {item.exitCode}
            </Badge>
          ) : null}
          <Badge tone={ITEM_STATUS_TONES[item.status]} pulse={active}>
            {ITEM_STATUS_LABELS[item.status]}
          </Badge>
        </span>
      </div>

      <div className="command-output-wrap">
        <button type="button" className="link-button command-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起输出' : `展开输出${lines > 0 ? `（${lines} 行 / ${formatBytes(output.length)}）` : ''}`}
        </button>
      </div>

      {expanded ? (
        <pre className="command-output" data-ctx="output" data-ctx-text={output}>
          <code>{output === '' ? (active ? '…' : '(无输出)') : output}</code>
        </pre>
      ) : null}
    </div>
  )
}

const CommandCard = memo(CommandCardImpl)
export default CommandCard
