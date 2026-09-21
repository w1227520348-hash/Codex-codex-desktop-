import { memo } from 'react'
import type { ReactNode } from 'react'
import ApprovalCard from '@renderer/components/ApprovalCard'
import Spinner from '@renderer/components/Spinner'
import TurnView from '@renderer/components/TurnView'
import { IconCuteMascot } from '@renderer/components/icons'
import FittedImage from '@renderer/components/FittedImage'
import { useStickToBottom } from '@renderer/hooks/useStickToBottom'
import { useSlotImage, useAppearanceRuntime } from '@renderer/hooks/useAppearance'
import type { ApprovalDecision, ApprovalRequest, SessionDetail } from '@shared/types'

export interface ChatPanelProps {
  detail: SessionDetail | null
  loaded: boolean
  /** 是否已经选中了某个会话 */
  hasSession: boolean
  workspace: string | null
  running: boolean
  approvals: ApprovalRequest[]
  /** 已做出决定、保留展示结论的审批 */
  resolvedApprovals: ApprovalRequest[]
  approvalDecisions: Record<string, ApprovalDecision>
  apiKeyMissing: boolean
  onDecideApproval: (approvalId: string, decision: ApprovalDecision) => void
  onViewDiff: (paths: string[], label: string) => void
  onOpenSettings: () => void
  onPickWorkspace: () => void
  onNewSession: () => void
}

/** 中间对话区：按轮次渲染 */
function ChatPanelImpl({
  detail,
  loaded,
  hasSession,
  workspace,
  running,
  approvals,
  resolvedApprovals,
  approvalDecisions,
  apiKeyMissing,
  onDecideApproval,
  onViewDiff,
  onOpenSettings,
  onPickWorkspace,
  onNewSession
}: ChatPanelProps): ReactNode {
  const turns = detail?.turns ?? []
  const scrollRef = useStickToBottom<HTMLDivElement>(`${turns.length}-${turns[turns.length - 1]?.events.length ?? 0}`)

  const body = ((): ReactNode => {
    if (!workspace) {
      return (
        <EmptyState
          title="先选一个工作目录"
          lines={['Codex 只能在你指定的目录里读文件、跑命令。', '点击左侧「选择目录」开始。']}
          action={{ label: '选择目录', onClick: onPickWorkspace }}
        />
      )
    }

    if (!hasSession) {
      return (
        <EmptyState
          title="准备就绪，等待你的第一条指令"
          lines={[
            `工作目录：${workspace}`,
            '在下方输入框里描述你想要的改动，回车即可让 Codex 开始工作。',
            '需要新建一个独立会话时，点左侧「新建任务」。'
          ]}
          action={{ label: '新建任务', onClick: onNewSession }}
        />
      )
    }

    if (!loaded) {
      return <EmptyState title="正在载入…" lines={['正在从本机读取会话记录。']} />
    }

    if (turns.length === 0) {
      return (
        <EmptyState
          title="这个会话还没有内容"
          lines={[
            `工作目录：${workspace}`,
            '在下方输入框里描述你想要的改动，回车即可让 Codex 开始工作。'
          ]}
        />
      )
    }

    return null
  })()

  return (
    <main className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {apiKeyMissing ? (
            <div className="notice notice-warn notice-sticky">
              <span className="notice-icon" aria-hidden="true">
                ⚠
              </span>
              <div className="notice-body">
                <div className="notice-title">还没有配置 DeepSeek API Key</div>
                <div className="notice-text">
                  没有 Key 就无法调用模型。请到「设置」里填写，Key 只保存在本机 ~/.codex-desktop/config.json。
                </div>
              </div>
              <button type="button" className="button button-ghost button-sm" onClick={onOpenSettings}>
                去设置
              </button>
            </div>
          ) : null}

          {body}

          {turns.map((turn, index) => (
            <TurnView
              key={turn.id}
              turn={turn}
              running={running && index === turns.length - 1}
              onViewDiff={onViewDiff}
            />
          ))}

          {approvals.length > 0 ? (
            <section className="approval-stack">
              <div className="approval-stack-head">
                <Spinner size={12} />
                <span>有 {approvals.length} 个动作等待你批准</span>
              </div>
              {approvals.map((request) => (
                <ApprovalCard
                  key={request.id}
                  request={request}
                  decision={approvalDecisions[request.id] ?? null}
                  onDecide={onDecideApproval}
                  onViewDiff={onViewDiff}
                />
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </main>
  )
}

interface EmptyStateProps {
  title: string
  lines: string[]
  action?: { label: string; onClick: () => void }
}

function EmptyState({ title, lines, action }: EmptyStateProps): ReactNode {
  const art = useSlotImage('emptyState')
  const artTransform = useAppearanceRuntime().appearance.slots.emptyState?.transform
  return (
    <div className="empty-state">
      <div className="empty-art" aria-hidden="true">
        {art.src ? (
          <FittedImage source={art.src} transform={artTransform} onError={art.onError} />
        ) : (
          <IconCuteMascot />
        )}
      </div>
      <h2 className="empty-title">{title}</h2>
      {lines.map((line, index) => (
        <p className="empty-line" key={`${line}-${index}`}>
          {line}
        </p>
      ))}
      {action ? (
        <button type="button" className="button button-primary" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

const ChatPanel = memo(ChatPanelImpl)
export default ChatPanel
