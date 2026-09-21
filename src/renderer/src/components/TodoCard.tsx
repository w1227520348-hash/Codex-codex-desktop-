import { memo } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import type { HarnessItem } from '@shared/types'

export interface TodoCardProps {
  item: Extract<HarnessItem, { kind: 'todo_list' }>
}

/** 模型的待办清单 */
function TodoCardImpl({ item }: TodoCardProps): ReactNode {
  const done = item.items.filter((entry) => entry.completed).length

  return (
    <div className="todo-card">
      <div className="todo-head">
        <span className="todo-title">任务清单</span>
        <Badge tone={done === item.items.length && item.items.length > 0 ? 'success' : 'info'}>
          {done}/{item.items.length}
        </Badge>
      </div>
      <ul className="todo-list">
        {item.items.length === 0 ? <li className="todo-empty">清单为空</li> : null}
        {item.items.map((entry, index) => (
          <li className={['todo-item', entry.completed ? 'todo-done' : ''].filter(Boolean).join(' ')} key={`${entry.text}-${index}`}>
            <span className="todo-check" aria-hidden="true">
              {entry.completed ? '✓' : '○'}
            </span>
            <span className="todo-text">{entry.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const TodoCard = memo(TodoCardImpl)
export default TodoCard
