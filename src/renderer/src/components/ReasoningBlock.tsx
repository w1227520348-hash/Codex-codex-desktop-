import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from '@renderer/components/Markdown'
import type { HarnessItem } from '@shared/types'
import { oneLine } from '@renderer/utils/format'

export interface ReasoningBlockProps {
  item: Extract<HarnessItem, { kind: 'reasoning' }>
  defaultOpen?: boolean
}

/** 思考过程：灰底等宽、默认折叠，流式中自动展开 */
function ReasoningBlockImpl({ item, defaultOpen = false }: ReasoningBlockProps): ReactNode {
  const streaming = item.status === 'in_progress'
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? (defaultOpen || streaming)

  return (
    <div className={['reasoning', open ? 'reasoning-open' : ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="reasoning-head"
        onClick={() => setManual(!open)}
        aria-expanded={open}
      >
        <span className={['reasoning-caret', open ? 'reasoning-caret-open' : ''].join(' ')} aria-hidden="true">
          ▶
        </span>
        <span className="reasoning-title">{streaming ? '思考中…' : '思考过程'}</span>
        {!open ? <span className="reasoning-preview">{oneLine(item.text, 90)}</span> : null}
        {streaming ? <span className="reasoning-pulse" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div className="reasoning-body">
          <Markdown source={item.text} streaming={streaming} />
        </div>
      ) : null}
    </div>
  )
}

const ReasoningBlock = memo(ReasoningBlockImpl)
export default ReasoningBlock
