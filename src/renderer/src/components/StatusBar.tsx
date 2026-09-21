import { memo } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import { Spinner } from '@renderer/components/Spinner'
import { IconGear, IconMoon, IconStop, IconSun } from '@renderer/components/icons'
import { useElapsed } from '@renderer/hooks/useElapsed'
import type { PermissionMode, RunStatus, SessionSummary, StylePreset, ThemeMode } from '@shared/types'
import { basename, formatCount, formatDuration, PERMISSION_BADGE_TEXT, shortenPath } from '@renderer/utils/format'

export interface StatusBarProps {
  status: RunStatus
  workspace: string | null
  model: string
  permissionMode: PermissionMode
  theme: ThemeMode
  resolvedTheme: 'light' | 'dark'
  apiKeyMissing: boolean
  session: SessionSummary | null
  onStop: () => void
  onToggleTheme: () => void
  onToggleRightPanel: () => void
  rightPanelOpen: boolean
  onOpenSettings: () => void
  /** 手动压缩上下文 */
  onCompact: () => void
  /** 打开个性化设置抽屉 */
  onOpenPersonalization: () => void
  /** 当前视觉风格 */
  stylePreset: StylePreset
  /** 在「个性化（二次元）」与「系统默认（经典）」之间切换 */
  onToggleStyle: () => void
}

/** 顶部状态条：运行中显示指示器 + 当前工具 + 已运行时长 + 停止 */
function StatusBarImpl({
  status,
  workspace,
  model,
  permissionMode,
  theme,
  resolvedTheme,
  apiKeyMissing,
  session,
  onStop,
  onToggleTheme,
  onToggleRightPanel,
  rightPanelOpen,
  onOpenSettings,
  onCompact,
  onOpenPersonalization,
  stylePreset,
  onToggleStyle
}: StatusBarProps): ReactNode {
  const elapsed = useElapsed(status.running, status.startedAt)

  // 上下文占用：让用户看得见离压缩/超限还有多远
  const used = status.contextUsedTokens
  const window = status.contextWindow
  const ratio = used !== null && window ? used / window : null
  const contextTone = ratio === null ? 'neutral' : ratio >= 0.85 ? 'danger' : ratio >= 0.6 ? 'warn' : 'neutral'
  const contextText =
    used !== null && window
      ? `上下文 ${formatCount(used)} / ${formatCount(window)}（${Math.round((ratio ?? 0) * 100)}%）`
      : null

  return (
    <header className="statusbar">
      <div className="statusbar-left">
        {status.running ? (
          <>
            <span className="statusbar-run">
              <Spinner size={13} />
              <span className="statusbar-run-text">运行中</span>
            </span>
            <span className="statusbar-tool" title="当前工具">
              {status.currentTool ?? '等待模型返回…'}
            </span>
            <span className="statusbar-elapsed" title="已运行时长">
              {formatDuration(elapsed)}
            </span>
            <button type="button" className="button button-danger button-sm" onClick={onStop}>
              <IconStop size={12} />
              停止
            </button>
          </>
        ) : (
          <>
            <span className="statusbar-idle">
              {apiKeyMissing ? '未配置 API Key' : '空闲'}
            </span>
            <span className="statusbar-workspace" title={workspace ?? ''}>
              {workspace ? shortenPath(workspace, 3) : '未选择工作目录'}
            </span>
            <Badge tone="neutral" title="当前模型">
              {model}
            </Badge>
            <Badge tone={permissionMode === 'danger-full-access' ? 'danger' : 'info'} title="权限模式">
              {PERMISSION_BADGE_TEXT[permissionMode]}
            </Badge>
            {status.turnCount > 0 ? (
              <span className="statusbar-turns">已执行 {status.turnCount} 轮</span>
            ) : null}
            {status.hasContext ? (
              <Badge tone="info" title="本会话持有 codex thread，后续提问会续接上下文">
                已续接上下文
              </Badge>
            ) : null}
            {contextText ? (
              <Badge tone={contextTone} title="codex 报告的上下文占用 / 窗口（达 85% 会提示压缩）">
                {contextText}
              </Badge>
            ) : null}
            {status.hasContext ? (
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={onCompact}
                title="让 codex 压缩本会话上下文（把旧对话摘要化，thread 继续沿用）"
              >
                压缩上下文
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="statusbar-right">
        {session ? (
          <span className="statusbar-session" title={session.title}>
            {session.title === '' ? '未命名任务' : session.title}
            <span className="statusbar-session-ws"> · {basename(session.workspace)}</span>
          </span>
        ) : null}

        {apiKeyMissing ? (
          <button type="button" className="button button-warn button-sm" onClick={onOpenSettings}>
            填写 API Key
          </button>
        ) : null}

        {/*
          快捷切换：只在两种「外观预设」之间切换。
          只改 stylePreset，背景图 / 壁纸 / 头像 / 框选参数等个性化数据一律保留。
        */}
        <button
          type="button"
          className="button button-ghost button-sm style-toggle"
          aria-label="切换个性化外观"
          title={
            stylePreset === 'anime'
              ? '当前：个性化（二次元）。点击切换到系统默认外观 —— 你的背景图、头像等个性化数据会完整保留'
              : '当前：系统默认（经典）。点击切回个性化（二次元）—— 之前保存的个性化数据会原样恢复'
          }
          onClick={onToggleStyle}
        >
          <span className="style-toggle-emoji" aria-hidden="true">
            {stylePreset === 'anime' ? '🎀' : '🖥'}
          </span>
          {stylePreset === 'anime' ? '二次元' : '经典'}
        </button>

        <button
          type="button"
          className="icon-button"
          title="个性化设置（背景图与程序内图片）"
          aria-label="个性化设置"
          onClick={onOpenPersonalization}
        >
          <IconGear size={15} />
        </button>

        <button
          type="button"
          className="icon-button"
          title={theme === 'system' ? `跟随系统（当前 ${resolvedTheme === 'dark' ? '深色' : '浅色'}）` : '切换深浅色主题'}
          aria-label="切换主题"
          onClick={onToggleTheme}
        >
          {resolvedTheme === 'dark' ? <IconMoon size={15} /> : <IconSun size={15} />}
        </button>

        <button
          type="button"
          className={['button', 'button-ghost', 'button-sm', rightPanelOpen ? 'button-on' : ''].filter(Boolean).join(' ')}
          onClick={onToggleRightPanel}
          title="折叠 / 展开右侧面板"
        >
          {rightPanelOpen ? '收起面板' : '展开面板'}
        </button>
      </div>
    </header>
  )
}

const StatusBar = memo(StatusBarImpl)
export default StatusBar
