import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import WorkspaceFiles from '@renderer/components/WorkspaceFiles'
import { IconGear, IconPlus, IconRobot, IconStethoscope, IconTrash } from '@renderer/components/icons'
import { useAppearanceRuntime, useSlotImage } from '@renderer/hooks/useAppearance'
import FittedImage from '@renderer/components/FittedImage'
import type { SessionSummary } from '@shared/types'
import {
  basename,
  formatRelative,
  SESSION_STATUS_TEXT,
  SESSION_STATUS_TONES,
  shortenPath
} from '@renderer/utils/format'

export interface SidebarProps {
  workspace: string | null
  recentWorkspaces: string[]
  sessions: SessionSummary[]
  activeSessionId: string | null
  runningSessionId: string | null
  listError: string | null
  onPickWorkspace: () => void
  onSelectWorkspace: (workspace: string) => void
  onNewSession: () => void
  onLoadSession: (id: string) => void
  onDeleteSession: (id: string) => void
  /** 把工作区里的文件交给 Codex（点文件树或右键菜单都会走这里） */
  onAttachFiles: (paths: string[]) => void
  onOpenSettings: () => void
  onOpenEnv: () => void
}

/** 左侧栏：工作区选择 + 文件树 + 新建任务 + 会话历史 + 底部入口 */
function SidebarImpl({
  workspace,
  recentWorkspaces,
  sessions,
  activeSessionId,
  runningSessionId,
  listError,
  onPickWorkspace,
  onSelectWorkspace,
  onNewSession,
  onLoadSession,
  onDeleteSession,
  onAttachFiles,
  onOpenSettings,
  onOpenEnv
}: SidebarProps): ReactNode {
  const brand = useSlotImage('brandLogo')
  const brandTransform = useAppearanceRuntime().appearance.slots.brandLogo?.transform
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const recent = recentWorkspaces.filter((item) => item !== workspace)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand-mark" aria-hidden="true">
          {brand.src ? (
            <FittedImage
              source={brand.src}
              transform={brandTransform}
              onError={brand.onError}
            />
          ) : (
            <IconRobot size={16} />
          )}
        </span>
        <div className="brand-text">
          <div className="brand-name">Codex 驾驶舱</div>
          <div className="brand-sub">DeepSeek 模型 · 本机执行</div>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-label">工作目录</div>
        <div className="workspace-box">
          <div
            className="workspace-current"
            title={workspace ?? '未选择'}
            data-ctx="workspace"
            data-path={workspace ?? ''}
          >
            <span className="workspace-name">{workspace ? basename(workspace) : '未选择目录'}</span>
            <span className="workspace-path">{workspace ? shortenPath(workspace, 2) : '选择后 Codex 只能访问该目录'}</span>
          </div>
          <div className="workspace-actions">
            <button type="button" className="button button-ghost button-sm" onClick={onPickWorkspace}>
              选择目录
            </button>
            {recent.length > 0 ? (
              <button
                type="button"
                className="button button-quiet button-sm"
                onClick={() => setDropdownOpen((value) => !value)}
                aria-expanded={dropdownOpen}
                title="最近使用的目录"
              >
                最近 ▾
              </button>
            ) : null}
          </div>

          {dropdownOpen && recent.length > 0 ? (
            <ul className="workspace-dropdown">
              {recent.map((item) => (
                <li key={item}>
                  <button
                    type="button"
                    className="workspace-option"
                    onClick={() => {
                      onSelectWorkspace(item)
                      setDropdownOpen(false)
                    }}
                    title={item}
                  >
                    <span className="workspace-option-name">{basename(item)}</span>
                    <span className="workspace-option-path">{shortenPath(item, 3)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <button type="button" className="button button-primary button-block" onClick={onNewSession}>
          <IconPlus size={14} />
          新建任务
        </button>
      </div>

      <WorkspaceFiles workspace={workspace} onAttach={onAttachFiles} />

      <div className="sidebar-section sidebar-section-grow">
        <div className="sidebar-section-label">
          会话历史
          <span className="sidebar-count">{sessions.length}</span>
        </div>

        {listError ? <div className="sidebar-error">读取失败：{listError}</div> : null}

        {sessions.length === 0 && !listError ? (
          <div className="sidebar-empty">
            <p>还没有任何会话。</p>
            <p>选好目录后点「新建任务」开始。</p>
          </div>
        ) : null}

        <ul className="session-list">
          {sessions.map((session) => {
            const active = session.id === activeSessionId
            const running = session.id === runningSessionId || session.status === 'running'
            return (
              <li key={session.id}>
                <div
                  className={['session-item', active ? 'session-item-active' : ''].filter(Boolean).join(' ')}
                  data-ctx="session"
                  data-path={session.workspace}
                  data-session-id={session.id}
                  data-name={session.title}
                >
                  <button type="button" className="session-main" onClick={() => onLoadSession(session.id)} title={session.title}>
                    <span className="session-title">{session.title === '' ? '未命名任务' : session.title}</span>
                    <span className="session-meta">
                      <span className="session-workspace">{basename(session.workspace)}</span>
                      <span className="session-dot">·</span>
                      <span className="session-time">{formatRelative(session.updatedAt)}</span>
                    </span>
                  </button>

                  <div className="session-right">
                    <Badge tone={SESSION_STATUS_TONES[session.status]} pulse={running}>
                      {SESSION_STATUS_TEXT[session.status]}
                    </Badge>
                    {confirmId === session.id ? (
                      <span className="session-confirm">
                        <button
                          type="button"
                          className="button button-danger button-xs"
                          onClick={() => {
                            onDeleteSession(session.id)
                            setConfirmId(null)
                          }}
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          className="button button-quiet button-xs"
                          onClick={() => setConfirmId(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="icon-button session-delete"
                        title="删除该会话"
                        aria-label="删除该会话"
                        onClick={() => setConfirmId(session.id)}
                      >
                        <IconTrash size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="sidebar-foot">
        <button type="button" className="button button-ghost button-block" onClick={onOpenSettings}>
          <IconGear size={14} />
          设置
        </button>
        <button type="button" className="button button-ghost button-block" onClick={onOpenEnv}>
          <IconStethoscope size={14} />
          环境自检
        </button>
      </div>
    </aside>
  )
}

const Sidebar = memo(SidebarImpl)
export default Sidebar
