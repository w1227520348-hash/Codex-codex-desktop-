/**
 * 任务编排：把「桥 + exec 引擎 + 会话持久化 + 运行状态」串起来。
 * 只依赖注入的 emit 回调，方便脱离 Electron 单测。
 */

import type { BridgeHandle, BridgeNotice } from '../core/bridge/server'
import { startBridge } from '../core/bridge/server'
import { AppServerEngine } from '../core/appServerEngine'
import { ExecEngine } from '../core/execEngine'
import { listChanges } from '../core/diff'
import { buildAttachmentPrompt, readInlineText } from '../core/attachments'
import {
  createSession,
  createTurn,
  deriveTitle,
  loadSession,
  mergeEventInto,
  saveSession
} from '../core/sessions'
import { loadSettings, rememberWorkspace, saveSettings } from '../core/settings'
import type {
  ApprovalDecision,
  AppSettings,
  HarnessEvent,
  PermissionMode,
  RunStatus,
  SessionDetail,
  SessionTurn,
  StartTaskInput,
  StartTaskResult
} from '../shared/types'

export type EmitFn = (channel: string, payload: unknown) => void

export class Orchestrator {
  private bridge: BridgeHandle | null = null
  private readonly engine = new ExecEngine()
  private readonly appServer = new AppServerEngine()
  /** 本轮实际使用的引擎，供取消与审批路由使用 */
  private activeEngine: 'exec' | 'app-server' = 'exec'
  private activeSessionId: string | null = null
  private activeDetail: SessionDetail | null = null
  private activeTurn: SessionTurn | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private startedAt: number | null = null
  private currentTool: string | null = null
  private threadId: string | null = null
  private turnCount = 0
  private lastError: string | null = null
  /** 最近一次上下文占用（exec 引擎没有常驻用量，用它记着） */
  private lastContextUsed: number | null = null
  /** 空闲回收定时器：常驻的 app-server 会一直占着工作目录（cwd），久不用要释放 */
  private idleTimer: NodeJS.Timeout | null = null
  /**
   * 自己维护「任务是否在进行中」。
   * 不能用 engine.isRunning：那里要等 CLI 定位 + 配置生成 + spawn 完成才为 true，
   * 中间这段窗口会让 UI 以为没在跑，也无法阻止重复启动。
   */
  private taskActive = false

  constructor(private readonly emit: EmitFn) {}

  /* ---------------- 桥 ---------------- */

  get bridgeBaseUrl(): string {
    return this.bridge?.baseUrl ?? ''
  }

  get bridgeUpstream(): string {
    return loadSettings().baseUrl
  }

  get bridgeLogs(): { at: number; level: string; message: string }[] {
    return this.bridge?.getLogs() ?? []
  }

  async ensureBridge(): Promise<BridgeHandle> {
    const settings = loadSettings()
    if (this.bridge) return this.bridge
    this.bridge = await startBridge({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxOutputTokens,
      onNotice: (notice) => this.handleBridgeNotice(notice)
    })
    return this.bridge
  }

  /** 设置变更后重建桥（key/模型/温度都在桥里生效） */
  async restartBridge(): Promise<void> {
    if (this.bridge) {
      await this.bridge.close().catch(() => undefined)
      this.bridge = null
    }
    if (!loadSettings().useNativeResponses) await this.ensureBridge()
  }

  private handleBridgeNotice(notice: BridgeNotice): void {
    const sessionId = this.activeSessionId
    if (!sessionId) return
    this.pushEvent(sessionId, { type: 'notice', level: notice.level, message: notice.message })
  }

  /* ---------------- 状态 ---------------- */

  getStatus(): RunStatus {
    const context = this.appServer.contextInfo
    return {
      sessionId: this.activeSessionId,
      running: this.taskActive,
      currentTool: this.currentTool,
      threadId: this.threadId,
      startedAt: this.startedAt,
      turnCount: this.turnCount,
      hasContext: this.activeDetail ? Boolean(this.activeDetail.codexThreadId) : false,
      contextUsedTokens: context.usedTokens ?? this.lastContextUsed,
      contextWindow: context.window ?? loadSettings().modelContextWindow
    }
  }

  private emitStatus(): void {
    this.emit('harness:status', this.getStatus())
  }

  /**
   * 一轮结束后安排空闲回收。
   * 常驻 app-server 的价值是保住 thread 上下文，但它同时也把工作目录当 cwd 占着
   * （Windows 下会导致该目录无法删除/改名）。空闲一段时间就回收，兼顾两头。
   */
  private scheduleIdleReap(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = null
        if (this.taskActive) return
        if (this.appServer.currentThreadId) {
          this.pushEvent(this.activeSessionId ?? '', {
            type: 'notice',
            level: 'info',
            message: '会话进程已空闲回收（上下文仍保存在 codex 里，下次提问会自动续接）。'
          })
        }
        this.appServer.dispose()
        this.emitStatus()
      },
      10 * 60 * 1000
    )
  }

  private pushEvent(sessionId: string, event: HarnessEvent): void {
    const isActive = this.activeSessionId === sessionId && this.activeTurn !== null
    if (isActive && this.activeTurn) {
      mergeEventInto(this.activeTurn.events, event)
      this.scheduleSave()
    }
    this.emit('harness:event', { sessionId, event })
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.activeDetail) saveSession(this.activeDetail)
    }, 700)
  }

  private flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.activeDetail) saveSession(this.activeDetail)
  }

  /* ---------------- 任务 ---------------- */

  async startTask(input: StartTaskInput): Promise<StartTaskResult> {
    if (this.taskActive) {
      return { ok: false, error: '已有任务正在运行，请先等待完成或点击「停止」。' }
    }

    const settings = loadSettings()
    if (settings.apiKey.length === 0) {
      return { ok: false, error: '尚未配置 DeepSeek API Key，请先在「设置」里填写。' }
    }
    if (!input.workspace || input.workspace.trim().length === 0) {
      return { ok: false, error: '请先选择工作目录。' }
    }

    // 同步占位：从这一刻起就算「在跑」，避免 await 期间被重复启动或被当成空闲
    this.taskActive = true
    this.engine.reset()
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }

    if (!settings.useNativeResponses) {
      try {
        await this.ensureBridge()
      } catch (error) {
        this.taskActive = false
        return { ok: false, error: `协议桥启动失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    const detail = loadSession(input.sessionId) ?? createSession(input.workspace, settings.model, input.permissionMode)
    detail.workspace = input.workspace
    detail.model = settings.model
    detail.permissionMode = input.permissionMode
    detail.status = 'running'
    detail.updatedAt = Date.now()
    if (detail.turns.length === 0) detail.title = deriveTitle(input.prompt)

    const turn = createTurn(input.prompt, input.attachments)
    detail.turns.push(turn)

    /**
     * 真正发给 codex 的输入 = 用户原话 + 附件清单/正文。
     * 界面上展示的仍是用户原话（turn.prompt），否则一轮里塞进几万字文件内容会把对话看糊。
     */
    const attachments = input.attachments ?? []
    const enginePrompt =
      attachments.length === 0
        ? input.prompt
        : buildAttachmentPrompt(
            input.prompt,
            attachments.map((attachment) => ({ attachment, text: readInlineText(attachment) }))
          )

    this.activeSessionId = detail.id
    this.activeDetail = detail
    this.activeTurn = turn
    this.startedAt = Date.now()
    this.currentTool = null
    this.threadId = null
    this.turnCount = detail.turns.length
    this.lastError = null

    rememberWorkspace(input.workspace)
    saveSession(detail)
    this.emit('session:updated', detail.id)
    this.emitStatus()

    // 事件泵
    const onEvent = (event: HarnessEvent): void => {
      this.observeEvent(event)
      this.pushEvent(detail.id, event)
    }

    /**
     * 附件说明必须走事件泵（pushEvent）才会同时进入会话记录和界面。
     * 早先直接 turn.events.push，只落盘、不推渲染层，界面上根本看不到。
     */
    if (attachments.length > 0) {
      onEvent({
        type: 'notice',
        level: 'info',
        message: `本轮提交了 ${attachments.length} 个文件：${attachments
          .map(
            (a) =>
              `${a.name}${a.inlined ? '（已内联）' : a.kind === 'text' ? '（未内联，交给工具读取）' : `（${a.kind}，交给工具读取）`}`
          )
          .join('、')}`
      })
    }

    const taskOptions = {
      workspace: input.workspace,
      prompt: enginePrompt,
      permissionMode: input.permissionMode,
      settings,
      bridgeBaseUrl: this.bridgeBaseUrl,
      onEvent,
      // 关键：把本会话已有的 codex thread 传下去 → 续接上下文
      resumeThreadId: detail.codexThreadId ?? null,
      sessionId: detail.id
    }

    /**
     * 引擎选择：
     *   - 审批模式（app-server）：支持逐动作审批；若握手阶段就失败（实验性协议变动等），
     *     此时还没有任何副作用，安全回退到 exec 引擎，保证任务不会白白失败。
     *   - 稳定模式（exec）：直接跑一次性 codex exec。
     */
    const run = async (): Promise<void> => {
      this.activeEngine = settings.engine
      if (settings.engine === 'app-server') {
        this.appServer.reset()
        const handled = await this.appServer.start(taskOptions)
        if (handled) return
        onEvent({
          type: 'notice',
          level: 'warn',
          message: '审批模式不可用，已自动回退到稳定模式（exec）。可稍后在「设置」里切换引擎。'
        })
        this.activeEngine = 'exec'
      }
      this.engine.reset()
      await this.engine.start(taskOptions)
    }

    void run()
      .then(() => {
        turn.endedAt = Date.now()
        // 记下 thread id：这是「下一轮还能接上上下文」的唯一凭据
        const threadId = this.activeEngine === 'app-server' ? this.appServer.currentThreadId : this.engine.currentThreadId
        if (threadId) {
          detail.codexThreadId = threadId
          turn.threadId = threadId
          this.threadId = threadId
        }
        const cancelled = this.activeEngine === 'app-server' ? this.appServer.wasCancelled : this.engine.wasCancelled
        if (cancelled) {
          turn.status = 'cancelled'
          detail.status = 'cancelled'
        } else if (this.lastError) {
          turn.status = 'failed'
          detail.status = 'failed'
        } else {
          turn.status = 'completed'
          detail.status = 'completed'
        }
        detail.updatedAt = Date.now()
        this.activeTurn = null
        this.currentTool = null
        this.taskActive = false
        this.flushSave()
        this.emit('session:updated', detail.id)
        this.emitStatus()
        this.scheduleIdleReap()
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        onEvent({ type: 'error', message: `引擎异常：${message}`, fatal: true })
        turn.status = 'failed'
        turn.endedAt = Date.now()
        detail.status = 'failed'
        detail.updatedAt = Date.now()
        this.activeTurn = null
        this.currentTool = null
        this.taskActive = false
        this.flushSave()
        this.emit('session:updated', detail.id)
        this.emitStatus()
        this.scheduleIdleReap()
      })

    return { ok: true, sessionId: detail.id }
  }

  /** 根据事件更新运行状态指示（当前工具名、token 用量、错误） */
  private observeEvent(event: HarnessEvent): void {
    switch (event.type) {
      case 'thread.started':
        this.threadId = event.threadId
        if (this.activeTurn) this.activeTurn.threadId = event.threadId
        break
      case 'item.started':
        this.currentTool = describeItem(event.item)
        break
      case 'item.completed':
        if (this.activeTurn) {
          const item = event.item
          if (item.kind === 'command_execution' && item.exitCode !== null && item.exitCode !== 0) {
            this.lastError = `命令退出码 ${item.exitCode}`
          }
        }
        break
      case 'turn.completed':
        this.currentTool = null
        if (this.activeTurn && event.usage) {
          const previous = this.activeTurn.usage
          this.activeTurn.usage = {
            inputTokens: (previous?.inputTokens ?? 0) + (event.usage.inputTokens ?? 0),
            outputTokens: (previous?.outputTokens ?? 0) + (event.usage.outputTokens ?? 0),
            totalTokens: (previous?.totalTokens ?? 0) + (event.usage.totalTokens ?? 0),
            cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (event.usage.cachedInputTokens ?? 0)
          }
        }
        break
      case 'turn.failed':
        this.lastError = event.message
        break
      case 'context.updated':
        this.lastContextUsed = event.usedTokens
        break
      case 'error':
        if (event.fatal) this.lastError = event.message
        break
      default:
        break
    }
    this.emitStatus()
  }

  async cancelTask(sessionId: string): Promise<boolean> {
    if (this.activeSessionId !== sessionId) return false
    if (!this.taskActive) return false
    this.pushEvent(sessionId, { type: 'notice', level: 'warn', message: '已请求停止任务，正在结束当前这一轮…' })
    // 两个引擎都调一遍：各自在未运行时是空操作
    if (this.activeEngine === 'app-server') this.appServer.cancel()
    this.engine.cancel()
    return true
  }

  /** M3：把界面上的「允许一次 / 总是允许 / 拒绝」回写给 codex app-server */
  respondApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    if (this.activeSessionId !== sessionId) return false
    return this.appServer.respondApproval(approvalId, decision)
  }

  /** 手动压缩当前会话的上下文（只有常驻的 app-server 引擎支持） */
  async compactContext(sessionId: string): Promise<boolean> {
    if (this.taskActive) return false
    const detail = loadSession(sessionId)
    if (!detail?.codexThreadId) return false

    const options = {
      workspace: detail.workspace,
      prompt: '',
      permissionMode: detail.permissionMode,
      settings: loadSettings(),
      bridgeBaseUrl: this.bridgeBaseUrl,
      onEvent: (event: HarnessEvent) => this.emit('harness:event', { sessionId, event }),
      resumeThreadId: detail.codexThreadId,
      sessionId: detail.id
    }

    this.appServer.reset()
    const attached = await this.appServer.attach(options)
    if (!attached) return false
    return this.appServer.compact()
  }

  /** 应用退出时调用：结束常驻进程 */
  disposeEngines(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.appServer.dispose()
  }

  setPermissionMode(mode: PermissionMode): AppSettings {
    return saveSettings({ permissionMode: mode })
  }

  async listWorkspaceChanges(workspace: string): Promise<{ path: string; kind: string }[]> {
    return listChanges(workspace)
  }
}

function describeItem(item: { kind: string; tool?: string }): string {
  switch (item.kind) {
    case 'command_execution':
      return '执行命令'
    case 'file_change':
      return '编辑文件'
    case 'agent_message':
      return '生成回复'
    case 'reasoning':
      return '思考中'
    case 'tool_call':
      return item.tool ?? '调用工具'
    case 'web_search':
      return '网络搜索'
    case 'todo_list':
      return '更新计划'
    default:
      return '处理中'
  }
}
