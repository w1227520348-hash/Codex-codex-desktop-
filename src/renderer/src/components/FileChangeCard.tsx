import { memo } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import type { HarnessItem } from '@shared/types'
import { fileKindMeta, ITEM_STATUS_LABELS, ITEM_STATUS_TONES } from '@renderer/utils/format'

export interface FileChangeCardProps {
  item: Extract<HarnessItem, { kind: 'file_change' }>
  /** 点击「查看 diff」时回调，参数是受影响文件路径 */
  onViewDiff?: (paths: string[], label: string) => void
}

/** file_change 卡片：列出文件 + 变更类型徽章 + 查看 diff */
function FileChangeCardImpl({ item, onViewDiff }: FileChangeCardProps): ReactNode {
  const paths = item.changes.map((change) => change.path)

  return (
    <div className="file-card">
      <div className="file-card-head">
        <span className="file-card-icon" aria-hidden="true">
          ▤
        </span>
        <span className="file-card-title">文件变更</span>
        <span className="file-card-count">{item.changes.length} 个文件</span>
        <Badge tone={ITEM_STATUS_TONES[item.status]} pulse={item.status === 'in_progress'}>
          {ITEM_STATUS_LABELS[item.status]}
        </Badge>
      </div>

      <ul className="file-list">
        {item.changes.length === 0 ? <li className="file-empty">未报告具体文件</li> : null}
        {item.changes.map((change, index) => {
          const meta = fileKindMeta(change.kind)
          return (
            <li className="file-item" key={`${change.path}-${index}`}>
              <span className="file-path" title={change.path}>
                {change.path}
              </span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </li>
          )
        })}
      </ul>

      <div className="file-card-actions">
        <button
          type="button"
          className="button button-ghost button-sm"
          title={paths.length === 0 ? '该条目没有报告文件路径' : '在右侧面板查看统一 diff'}
          onClick={() => onViewDiff?.(paths, item.changes.map((change) => change.path).join('、'))}
        >
          查看 diff
        </button>
      </div>
    </div>
  )
}

const FileChangeCard = memo(FileChangeCardImpl)
export default FileChangeCard
