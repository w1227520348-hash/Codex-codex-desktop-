import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import Markdown from '@renderer/components/Markdown'
import type { ApprovalDecision, ApprovalKind, ApprovalRequest } from '@shared/types'

export interface ApprovalCardProps {
  request: ApprovalRequest
  /** 已做出的决定（例如来自 approval.resolved 事件） */
  decision?: ApprovalDecision | null
  onDecide: (approvalId: string, decision: ApprovalDecision) => void
  onViewDiff?: (paths: string[], label: string) => void
}

const KIND_LABELS: Record<ApprovalKind, string> = {
  command: '命令执行',
  file_change: '文件写入',
  permissions: '权限申请'
}

const DECISION_TEXT: Record<ApprovalDecision, string> = {
  allow_once: '已允许一次该动作',
  allow_always: '已选择总是允许这类动作',
  deny: '已拒绝该动作'
}

const DECISION_TONE: Record<ApprovalDecision, 'success' | 'info' | 'danger'> = {
  allow_once: 'success',
  allow_always: 'info',
  deny: 'danger'
}

/** 审批卡片：醒目边框 + 详情 + 三个决定按钮，提交后禁用并显示结论 */
function ApprovalCardImpl({ request, decision, onDecide, onViewDiff }: ApprovalCardProps): ReactNode {
  const [local, setLocal] = useState<ApprovalDecision | null>(null)
  const resolved = local ?? decision ?? null
  const decided = resolved !== null

  const submit = (value: ApprovalDecision): void => {
    if (decided) return
    setLocal(value)
    onDecide(request.id, value)
  }

  const paths = request.paths ?? []

  return (
    <section className={['approval', decided ? 'approval-decided' : 'approval-pending'].join(' ')}>
      <header className="approval-head">
        <span className="approval-badge" aria-hidden="true">
          !
        </span>
        <div className="approval-titles">
          <div className="approval-title">{request.title === '' ? '需要你的批准' : request.title}</div>
          <div className="approval-sub">
            <Badge tone="warn">{KIND_LABELS[request.kind]}</Badge>
            <span className="approval-time">{new Date(request.createdAt).toLocaleTimeString('zh-CN')}</span>
          </div>
        </div>
      </header>

      {request.detail.trim() !== '' ? (
        <div className="approval-detail">
          <Markdown source={request.detail} />
        </div>
      ) : null}

      {request.command !== undefined && request.command !== '' ? (
        <div className="approval-block">
          <div className="approval-block-label">待执行命令</div>
          <pre className="command-output approval-command">
            <code>{request.command}</code>
          </pre>
        </div>
      ) : null}

      {paths.length > 0 ? (
        <div className="approval-block">
          <div className="approval-block-label">受影响文件</div>
          <ul className="approval-paths">
            {paths.map((path, index) => (
              <li key={`${path}-${index}`}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {request.reason !== undefined && request.reason.trim() !== '' ? (
        <div className="approval-reason">
          <span className="approval-reason-label">模型理由：</span>
          {request.reason}
        </div>
      ) : null}

      {request.patch !== undefined && request.patch.trim() !== '' ? (
        <div className="approval-block">
          <div className="approval-block-label">补丁预览</div>
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={() => onViewDiff?.(paths, '审批补丁')}
          >
            在右侧查看 diff
          </button>
        </div>
      ) : null}

      <footer className="approval-actions">
        {decided ? (
          <div className={['approval-result', `approval-result-${resolved ?? 'deny'}`].join(' ')}>
            <Badge tone={DECISION_TONE[resolved ?? 'deny']}>{DECISION_TEXT[resolved ?? 'deny']}</Badge>
            <span className="approval-result-hint">按钮已锁定，等待引擎继续</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="button button-primary"
              title="只批准这一次动作"
              onClick={() => submit('allow_once')}
            >
              允许一次
            </button>
            <button
              type="button"
              className="button button-ghost"
              title="同一条命令在本会话内不再询问（由 codex 记住这条命令，换一条命令仍会询问）"
              onClick={() => submit('allow_always')}
            >
              总是允许
            </button>
            <button
              type="button"
              className="button button-danger"
              title="拒绝这次动作，并把拒绝结果回给模型"
              onClick={() => submit('deny')}
            >
              拒绝
            </button>
          </>
        )}
      </footer>
    </section>
  )
}

const ApprovalCard = memo(ApprovalCardImpl)
export default ApprovalCard
