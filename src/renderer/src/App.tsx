import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ActivityStream from '@renderer/components/ActivityStream'
import ChatPanel from '@renderer/components/ChatPanel'
import Composer from '@renderer/components/Composer'
import type { ComposerHandle } from '@renderer/components/Composer'
import DiffPanel from '@renderer/components/DiffPanel'
import EnvPanel from '@renderer/components/EnvPanel'
import SettingsPanel from '@renderer/components/SettingsPanel'
import PersonalizationDrawer from '@renderer/components/PersonalizationDrawer'
import BackgroundLayer from '@renderer/components/BackgroundLayer'
import BackgroundEditor from '@renderer/components/BackgroundEditor'
import Sidebar from '@renderer/components/Sidebar'
import StatusBar from '@renderer/components/StatusBar'
import Toast from '@renderer/components/Toast'
import { IconActivity, IconDiff } from '@renderer/components/icons'
import { AppearanceContext, useAppearance } from '@renderer/hooks/useAppearance'
import { useHarness } from '@renderer/hooks/useHarness'
import { useTheme } from '@renderer/hooks/useTheme'
import type { ActivityEntry, ActivityFilter } from '@renderer/utils/activity'
import { collectActivity } from '@renderer/utils/activity'
import { handleContextProbe } from '@renderer/utils/contextTarget'
import {
  PERMISSION_MODE_LABELS,
  type AppearanceSettings,
  type AttachmentRef,
  type BackgroundTransform,
  type ImageSlotId
} from '@shared/types'

type RightTab = 'activity' | 'diff'

/**
 * 裁剪编辑的目标。
 * 背景与槽位走**同一套裁剪数学**，但写回的位置不同 —— 两者互不干扰：
 * 背景写 appearance.background.transform，槽位写 appearance.slots[id].transform。
 */
type EditTarget = { kind: 'background' } | { kind: 'slot'; id: ImageSlotId }

interface DiffState {
  text: string | null
  label: string | null
  /** 最近一次请求的路径，供「刷新」复用 */
  paths: string[]
  loading: boolean
}

/** 顶层布局与状态编排：左栏 / 对话区 / 右侧面板 + 两个模态 */
export default function App(): ReactNode {
  const harness = useHarness()
  const { state } = harness
  const resolvedTheme = useTheme(state.settings.theme)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [personalizationOpen, setPersonalizationOpen] = useState(false)
  /** 当前正在编辑裁剪的目标：全屏背景，或某个槽位（头像/图标/Logo） */
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  /**
   * 个性化草稿：抽屉里的改动先落到这里做实时预览，点「保存」才写进配置。
   * null = 用已保存的设置。
   */
  const [appearanceDraft, setAppearanceDraft] = useState<AppearanceSettings | null>(null)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightTab, setRightTab] = useState<RightTab>('activity')
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all')
  const [diff, setDiff] = useState<DiffState>({ text: null, label: null, paths: [], loading: false })
  const composerRef = useRef<ComposerHandle | null>(null)

  const turns = state.view.detail?.turns ?? []
  const sessionId = state.sessionId
  const apiKeyMissing = state.settings.apiKey.trim() === ''
  const running = state.status.running

  const activityEntries = useMemo(() => collectActivity(turns), [turns])
  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === sessionId) ?? null,
    [state.sessions, sessionId]
  )

  // 生效中的外观 = 草稿（若有）否则已保存值；hook 负责落成 CSS 变量与槽位解析
  const appearanceRuntime = useAppearance(appearanceDraft ?? state.settings.appearance)

  const saveAppearance = useCallback(
    async (draft: AppearanceSettings): Promise<void> => {
      const saved = await harness.saveSettings({ appearance: draft })
      if (!saved) throw new Error('保存失败：主进程没有返回新的配置。')
      setAppearanceDraft(null)
    },
    [harness]
  )

  /**
   * 快捷切换「个性化（二次元）」↔「系统默认（经典）」。
   * **只翻转 stylePreset**：背景图、内置壁纸、头像、框选/缩放参数等个性化数据全部原样保留，
   * 所以来回切不会丢任何设置。
   */
  const toggleStylePreset = useCallback((): void => {
    void harness.toggleStylePreset().then(() => setAppearanceDraft(null))
  }, [harness])

  /** 裁剪编辑：实时预览（按目标写回背景或槽位，两者互不影响） */
  const previewTransform = useCallback(
    (transform: BackgroundTransform): void => {
      const base = appearanceDraft ?? state.settings.appearance
      if (editTarget?.kind === 'slot') {
        const current = base.slots[editTarget.id]
        if (!current) return
        setAppearanceDraft({
          ...base,
          slots: { ...base.slots, [editTarget.id]: { ...current, transform } }
        })
        return
      }
      if (!base.background) return
      setAppearanceDraft({ ...base, background: { ...base.background, transform } })
    },
    [appearanceDraft, editTarget, state.settings.appearance]
  )

  /** 裁剪编辑：保存（写回已保存的配置，避免把抽屉里未保存的其它改动一起带下去） */
  const saveTransform = useCallback(
    async (transform: BackgroundTransform): Promise<void> => {
      const base = state.settings.appearance

      if (editTarget?.kind === 'slot') {
        const current = base.slots[editTarget.id]
        if (!current) throw new Error('该槽位还没有自定义图片，请先上传或粘贴图片。')
        const saved = await harness.saveSettings({
          appearance: { ...base, slots: { ...base.slots, [editTarget.id]: { ...current, transform } } }
        })
        if (!saved) throw new Error('保存失败：主进程没有返回新的配置。')
        setAppearanceDraft(null)
        return
      }

      if (!base.background) throw new Error('请先上传背景图或选择内置壁纸，再进入编辑。')
      const saved = await harness.saveSettings({
        appearance: { ...base, background: { ...base.background, transform } }
      })
      if (!saved) throw new Error('保存失败：主进程没有返回新的配置。')
      setAppearanceDraft(null)
    },
    [editTarget, harness, state.settings.appearance]
  )

  /* -------------------- 动作 -------------------- */

  const openSettings = useCallback(() => setSettingsOpen(true), [])

  const handlePickWorkspace = useCallback((): void => {
    void harness.pickWorkspace().then(() => composerRef.current?.focus())
  }, [harness])

  const handleNewSession = useCallback((): void => {
    void harness.newSession().then((summary) => {
      if (summary) composerRef.current?.focus()
    })
  }, [harness])

  const handleSend = useCallback(
    async (prompt: string, attachments: AttachmentRef[]): Promise<void> => {
      await harness.send(prompt, attachments)
    },
    [harness]
  )

  /** 把文件塞进输入框（侧栏文件树点击、右键菜单「交给 Codex 理解」都会走这里） */
  const handleAttachFiles = useCallback((paths: string[]): void => {
    composerRef.current?.addFiles(paths)
    composerRef.current?.focus()
  }, [])

  /**
   * 右键菜单里需要渲染层执行的动作。
   * 剪贴板/打开目录由主进程直接做，这里只处理要改界面状态的三种。
   */
  useEffect(() => {
    return window.api.onContextAction((action) => {
      if (action.action === 'attach' && action.paths) {
        handleAttachFiles(action.paths)
        return
      }
      if (action.action === 'remove-attachment' && action.attachmentId) {
        composerRef.current?.removeAttachment(action.attachmentId)
        return
      }
      if (action.action === 'clear-composer') {
        composerRef.current?.clear()
      }
    })
  }, [handleAttachFiles])

  const handleStop = useCallback((): void => {
    void harness.cancel()
  }, [harness])

  /** 手动压缩上下文：让 codex 把旧对话摘要化，thread 继续沿用 */
  const handleCompact = useCallback((): void => {
    void harness.compactContext()
  }, [harness])

  const handleToggleTheme = useCallback((): void => {
    const next: 'light' | 'dark' = resolvedTheme === 'dark' ? 'light' : 'dark'
    void harness.saveSettings({ theme: next })
  }, [harness, resolvedTheme])

  const handleOpenSettingsFromEmpty = useCallback((): void => {
    setSettingsOpen(true)
  }, [])

  /** 取 diff → 切到 Diff 标签页 */
  const handleViewDiff = useCallback(
    (paths: string[], label: string): void => {
      setRightOpen(true)
      setRightTab('diff')
      setDiff({ text: null, label, paths, loading: true })
      void harness.viewDiff(paths, label).then((text) => {
        if (text === null) {
          setDiff({ text: null, label, paths, loading: false })
          return
        }
        setDiff({ text, label, paths, loading: false })
      })
    },
    [harness]
  )

  const refreshPaths = diff.paths
  const handleRefreshDiff = useCallback((): void => {
    void harness.viewDiff(refreshPaths, diff.label ?? '统一 diff').then((text) => {
      setDiff((current) => ({ ...current, text: text ?? current.text, loading: false }))
    })
  }, [harness, refreshPaths, diff.label])

  const handleSelectActivity = useCallback(
    (entry: ActivityEntry): void => {
      if (entry.variant !== 'item' || entry.item.kind !== 'file_change') return
      const paths = entry.item.changes.map((change) => change.path)
      if (paths.length === 0) return
      handleViewDiff(paths, entry.title)
    },
    [handleViewDiff]
  )

  const composerDisabledReason = useMemo((): string | null => {
    if (!state.workspace) return '请先选择工作目录'
    if (apiKeyMissing) return '请先在「设置」里填写 DeepSeek API Key'
    return null
  }, [state.workspace, apiKeyMissing])

  /* -------------------- 渲染 -------------------- */

  return (
    <AppearanceContext.Provider value={appearanceRuntime}>
      {/*
        背景层：只在 data-has-bg=1 时显示，所以默认外观与改动前完全一致。
        图片本身由 BackgroundLayer 精确定位（缩放/平移/框选），遮罩单独一层。
      */}
      <BackgroundLayer />
      <div className="app-bg-overlay" aria-hidden="true" />

      <div
        className="app"
        // 右键目标必须在 contextmenu 之前上报：mousedown 严格早于它，避免菜单按上一个目标弹出
        onMouseDownCapture={(event) =>
          handleContextProbe(event, { sessionId, workspace: state.workspace, selectionText: window.getSelection()?.toString() ?? '' })
        }
        onContextMenuCapture={(event) =>
          handleContextProbe(event, { sessionId, workspace: state.workspace, selectionText: window.getSelection()?.toString() ?? '' })
        }
      >
      <Sidebar
        workspace={state.workspace}
        recentWorkspaces={state.settings.recentWorkspaces}
        sessions={state.sessions}
        activeSessionId={sessionId}
        runningSessionId={state.status.running ? state.status.sessionId : null}
        listError={state.listError}
        onPickWorkspace={handlePickWorkspace}
        onSelectWorkspace={harness.setWorkspace}
        onNewSession={handleNewSession}
        onLoadSession={(id) => void harness.loadSession(id)}
        onDeleteSession={(id) => void harness.removeSession(id)}
        onAttachFiles={handleAttachFiles}
        onOpenSettings={openSettings}
        onOpenEnv={() => setEnvOpen(true)}
      />

      <div className="main">
        <StatusBar
          status={state.status}
          workspace={state.workspace}
          model={state.settings.model}
          permissionMode={state.settings.permissionMode}
          theme={state.settings.theme}
          resolvedTheme={resolvedTheme}
          apiKeyMissing={apiKeyMissing}
          session={activeSession}
          onStop={handleStop}
          onToggleTheme={handleToggleTheme}
          onToggleRightPanel={() => setRightOpen((value) => !value)}
          rightPanelOpen={rightOpen}
          onOpenSettings={openSettings}
          onCompact={handleCompact}
          onOpenPersonalization={() => setPersonalizationOpen(true)}
          stylePreset={state.settings.appearance.stylePreset}
          onToggleStyle={toggleStylePreset}
        />

        <div className="workspace">
          <ChatPanel
            detail={state.view.detail}
            loaded={state.view.loaded}
            hasSession={Boolean(sessionId)}
            workspace={state.workspace}
            running={running}
            approvals={state.pendingApprovals}
            resolvedApprovals={state.resolvedApprovals}
            approvalDecisions={state.approvalDecisions}
            apiKeyMissing={apiKeyMissing}
            onDecideApproval={(approvalId, decision) => void harness.decideApproval(approvalId, decision)}
            onViewDiff={handleViewDiff}
            onOpenSettings={openSettings}
            onPickWorkspace={handlePickWorkspace}
            onNewSession={handleNewSession}
          />

          <Composer
            ref={composerRef}
            running={running}
            disabled={composerDisabledReason !== null}
            disabledReason={composerDisabledReason}
            permissionLabel={PERMISSION_MODE_LABELS[state.settings.permissionMode]}
            sessionId={sessionId}
            workspace={state.workspace}
            onSend={handleSend}
            onStop={handleStop}
          />
        </div>
      </div>

      <aside className={['rightpanel', rightOpen ? '' : 'rightpanel-collapsed'].filter(Boolean).join(' ')}>
        <div className="rightpanel-tabs">
          <button
            type="button"
            className={['tab', rightTab === 'activity' ? 'tab-active' : ''].filter(Boolean).join(' ')}
            onClick={() => {
              setRightTab('activity')
              setRightOpen(true)
            }}
          >
            <IconActivity size={14} />
            活动流
            {activityEntries.length > 0 ? <span className="tab-count">{activityEntries.length}</span> : null}
          </button>
          <button
            type="button"
            className={['tab', rightTab === 'diff' ? 'tab-active' : ''].filter(Boolean).join(' ')}
            onClick={() => {
              setRightTab('diff')
              setRightOpen(true)
            }}
          >
            <IconDiff size={14} />
            Diff 预览
          </button>
          <button
            type="button"
            className="icon-button tab-close"
            aria-label="折叠右侧面板"
            title="折叠右侧面板"
            onClick={() => setRightOpen(false)}
          >
            ✕
          </button>
        </div>

        <div className="rightpanel-body">
          {rightTab === 'activity' ? (
            <ActivityStream
              entries={activityEntries}
              filter={activityFilter}
              onFilterChange={setActivityFilter}
              onSelect={handleSelectActivity}
              running={running}
            />
          ) : (
            <DiffPanel
              text={diff.text}
              label={diff.label}
              loading={diff.loading}
              workspace={state.workspace}
              onRefresh={handleRefreshDiff}
            />
          )}
        </div>
      </aside>
      </div>

      <PersonalizationDrawer
        open={personalizationOpen}
        appearance={state.settings.appearance}
        onClose={() => setPersonalizationOpen(false)}
        onPreview={setAppearanceDraft}
        onSave={saveAppearance}
        onEditBackground={() => setEditTarget({ kind: 'background' })}
        onEditSlot={(id) => setEditTarget({ kind: 'slot', id })}
      />

      {/*
        背景与槽位共用同一个裁剪编辑器，只是取景框比例/形状与保存位置不同：
        头像用 1:1 圆形取景框，所见即所得。
      */}
      <BackgroundEditor
        open={editTarget !== null}
        source={
          editTarget?.kind === 'slot'
            ? (appearanceDraft ?? state.settings.appearance).slots[editTarget.id]?.source ?? null
            : (appearanceDraft ?? state.settings.appearance).background?.source ?? null
        }
        transform={
          editTarget?.kind === 'slot'
            ? (appearanceDraft ?? state.settings.appearance).slots[editTarget.id]?.transform
            : (appearanceDraft ?? state.settings.appearance).background?.transform
        }
        aspect={editTarget?.kind === 'slot' ? 1 : 16 / 9}
        mask={
          editTarget?.kind === 'slot' && (editTarget.id === 'userAvatar' || editTarget.id === 'assistantAvatar')
            ? 'circle'
            : 'rect'
        }
        title={editTarget?.kind === 'slot' ? '裁剪头像 / 图标' : '背景编辑'}
        subtitle={
          editTarget?.kind === 'slot'
            ? '图片只会显示在它所属的框架内（圆形框自动裁圆）。左边框选区域，右边实时预览最终效果。'
            : undefined
        }
        onClose={() => setEditTarget(null)}
        onPreview={previewTransform}
        onSave={saveTransform}
      />

      <SettingsPanel
        open={settingsOpen}
        settings={state.settings}
        resolvedTheme={resolvedTheme}
        onClose={() => setSettingsOpen(false)}
        onSave={harness.saveSettings}
      />

      <EnvPanel
        open={envOpen}
        report={state.env}
        loading={state.envLoading}
        onClose={() => setEnvOpen(false)}
        onRefresh={async () => {
          await harness.refreshEnv()
        }}
      />

      <Toast message={harness.error} onDismiss={harness.clearError} />
    </AppearanceContext.Provider>
  )
}
