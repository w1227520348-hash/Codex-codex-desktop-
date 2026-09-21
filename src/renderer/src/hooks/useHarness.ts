import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  AttachmentRef,
  EnvReport,
  HarnessEvent,
  PermissionMode,
  RunStatus,
  SessionDetail,
  SessionSummary,
  SessionTurn
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { SessionView } from '@renderer/utils/activity'
import { itemStatus } from '@renderer/utils/format'

/**
 * 渲染层唯一的编排 hook：订阅 IPC 流式事件、维护会话/轮次/审批状态。
 *
 * 流式增量策略：事件到达后只「追加」或「按 id 就地更新」，
 * 不做整表重建，也不触发主进程重新读取会话。
 */

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

export interface HarnessState {
  settings: AppSettings
  settingsLoaded: boolean
  sessions: SessionSummary[]
  /** 最近一次列表/载入失败的中文说明 */
  listError: string | null
  workspace: string | null
  sessionId: string | null
  view: SessionView
  status: RunStatus
  pendingApprovals: ApprovalRequest[]
  /** 已决定但可能还没等到 approval.resolved 的审批 */
  approvalDecisions: Record<string, ApprovalDecision>
  /** 已经决定过的审批（保留展示结论，例如「已拒绝」） */
  resolvedApprovals: ApprovalRequest[]
  /** 会话级提示条（notice / error / turn.failed） */
  diagnostics: HarnessEvent[]
  env: EnvReport | null
  envLoading: boolean
}

type Action =
  | { type: 'settings'; settings: AppSettings }
  | { type: 'sessions'; sessions: SessionSummary[]; error?: string | null }
  | { type: 'upsert-session'; summary: SessionSummary }
  | { type: 'remove-session'; id: string }
  | { type: 'workspace'; workspace: string | null }
  | { type: 'open-session'; id: string; detail: SessionDetail | null }
  | { type: 'set-view'; view: SessionView }
  | { type: 'append-turn'; sessionId: string; turn: SessionTurn }
  | { type: 'events'; sessionId: string; events: HarnessEvent[] }
  | { type: 'status'; status: RunStatus }
  | { type: 'approval-decision'; approvalId: string; decision: ApprovalDecision }
  | { type: 'clear-approvals' }
  | { type: 'env'; env: EnvReport | null; loading: boolean }

export const EMPTY_STATUS: RunStatus = {
  sessionId: null,
  running: false,
  currentTool: null,
  threadId: null,
  startedAt: null,
  turnCount: 0,
  hasContext: false,
  contextUsedTokens: null,
  contextWindow: null
}

function createInitialState(): HarnessState {
  return {
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
    sessions: [],
    listError: null,
    workspace: null,
    sessionId: null,
    view: { detail: null, loaded: false },
    status: EMPTY_STATUS,
    pendingApprovals: [],
    approvalDecisions: {},
    resolvedApprovals: [],
    diagnostics: [],
    env: null,
    envLoading: false
  }
}

/** 事件是否属于「新的一轮」的开端 */
function opensNewTurn(event: HarnessEvent): boolean {
  return event.type === 'turn.started' || event.type === 'item.started' || event.type === 'approval.request'
}

function turnStatusFromEvent(event: HarnessEvent): SessionTurn['status'] | null {
  switch (event.type) {
    case 'turn.completed':
      return 'completed'
    case 'turn.failed':
      return 'failed'
    case 'exit':
      return event.code === 0 || event.code === null ? 'completed' : 'failed'
    default:
      return null
  }
}

function isDiagnostic(event: HarnessEvent): boolean {
  return (
    event.type === 'notice' ||
    event.type === 'error' ||
    event.type === 'turn.failed' ||
    (event.type === 'exit' && event.code !== 0 && event.code !== null)
  )
}

/** 把事件追加到会话的当前轮次；同一 item.id 由渲染层的合并逻辑就地更新 */
function reduceEvents(state: HarnessState, sessionId: string, events: HarnessEvent[]): HarnessState {
  if (events.length === 0) return state
  // 事件只属于当前打开的会话；其它会话的事件先丢弃（列表状态由 listSessions 刷新）
  if (!state.sessionId || state.sessionId !== sessionId || !state.view.loaded || !state.view.detail) {
    return state
  }

  const detail = state.view.detail
  const turns = detail.turns.slice()
  let status = state.status
  let diagnostics = state.diagnostics
  const pending = state.pendingApprovals.slice()
  const resolved = state.resolvedApprovals.slice()
  const decisions = { ...state.approvalDecisions }

  for (const event of events) {
    if (event.type === 'approval.request') {
      const known =
        pending.some((request) => request.id === event.request.id) ||
        resolved.some((request) => request.id === event.request.id)
      if (!known) pending.push(event.request)
    }
    if (event.type === 'approval.resolved') {
      decisions[event.id] = event.decision
      const index = pending.findIndex((request) => request.id === event.id)
      if (index >= 0) {
        const [request] = pending.splice(index, 1)
        if (request && !resolved.some((item) => item.id === request.id)) resolved.push(request)
      }
    }
    if (isDiagnostic(event)) {
      diagnostics = [...diagnostics, event]
    }
  }

  const last = turns[turns.length - 1]
  const needsNewTurn = !last || (!opensNewTurn(events[0] ?? { type: 'turn.started' }) && last.status !== 'running')

  if (needsNewTurn) {
    // 收到了不属于任何已知轮次的事件（例如主进程自己起了一轮），新建一个占位轮次接住
    if (last) {
      const ended = finalizeTurn(last)
      turns[turns.length - 1] = ended
    }
    const created: SessionTurn = {
      id: `${sessionId}-turn-${Date.now()}-${turns.length}`,
      prompt: '',
      startedAt: Date.now(),
      status: 'running',
      events: []
    }
    turns.push(created)
  }

  const targetIndex = turns.length - 1
  const existing = turns[targetIndex]
  if (!existing) return state

  // 写时复制：TurnView 是 memo 的，必须换掉「轮次对象」和「events 数组」的引用，
  // 否则流式事件到达时子组件会因浅比较相等而跳过重渲染，界面看起来像卡住不刷新。
  const target: SessionTurn = { ...existing, events: existing.events.concat(events) }
  turns[targetIndex] = target

  for (const event of events) {
    const nextStatus = turnStatusFromEvent(event)
    if (nextStatus) target.status = nextStatus
    if (event.type === 'thread.started') target.threadId = event.threadId
    if (event.type === 'turn.completed' && event.usage) target.usage = event.usage
    if (event.type === 'item.completed' && itemStatus(event.item) !== 'in_progress') {
      status = { ...status, currentTool: null }
    }
    if (event.type === 'item.started' || event.type === 'item.updated') {
      if (itemStatus(event.item) === 'in_progress') {
        status = { ...status, currentTool: toolLabel(event) }
      }
    }
  }

  /**
   * 「是否正在运行」必须以主进程的 RunStatus 为权威，**不能**从轮次状态推断。
   *
   * 踩过的坑（exec 引擎）：JSONL 里的 turn.completed 会先到，但 codex 进程随后才退出，
   * 主进程要等进程 close 才把 taskActive 置 false。若这里按 target.status 推断，
   * 就会出现「界面显示空闲、主进程仍认为在跑」的分歧 —— 用户按 Enter 发送，
   * 被主进程以「已有任务正在运行」拒绝，看起来像莫名其妙的报错。
   */
  const running = status.running
  const nextDetail: SessionDetail = { ...detail, turns }
  const nextSessions = state.sessions.map((session) =>
    session.id === sessionId
      ? { ...session, updatedAt: Date.now(), status: running ? 'running' : target.status }
      : session
  )

  return {
    ...state,
    sessions: nextSessions,
    view: { detail: nextDetail, loaded: true },
    status: {
      ...status,
      sessionId,
      running,
      startedAt: running ? (status.startedAt ?? target.startedAt) : null,
      currentTool: running ? status.currentTool : null,
      turnCount: turns.length
    },
    pendingApprovals: pending,
    approvalDecisions: decisions,
    resolvedApprovals: resolved,
    diagnostics
  }
}

function toolLabel(event: HarnessEvent): string | null {
  if (event.type !== 'item.started' && event.type !== 'item.updated') return null
  const item = event.item
  switch (item.kind) {
    case 'command_execution':
      return 'exec_command'
    case 'file_change':
      return '文件变更'
    case 'tool_call':
      return item.tool
    case 'web_search':
      return 'web_search'
    case 'todo_list':
      return 'todo_list'
    case 'reasoning':
      return '思考中'
    case 'agent_message':
      return '生成回复'
    case 'error':
      return '错误'
    case 'unknown':
      return item.rawType
    default:
      return null
  }
}

function finalizeTurn(turn: SessionTurn): SessionTurn {
  if (turn.status !== 'running') return turn
  return { ...turn, status: 'completed', endedAt: turn.endedAt ?? Date.now() }
}

function reducer(state: HarnessState, action: Action): HarnessState {
  switch (action.type) {
    case 'settings':
      return { ...state, settings: action.settings, settingsLoaded: true }

    case 'sessions':
      return { ...state, sessions: action.sessions, listError: action.error ?? null }

    case 'upsert-session': {
      const exists = state.sessions.some((session) => session.id === action.summary.id)
      const sessions = exists
        ? state.sessions.map((session) => (session.id === action.summary.id ? action.summary : session))
        : [action.summary, ...state.sessions]
      return { ...state, sessions }
    }

    case 'remove-session':
      return { ...state, sessions: state.sessions.filter((session) => session.id !== action.id) }

    case 'workspace':
      return { ...state, workspace: action.workspace }

    case 'open-session': {
      const detail = action.detail
      return {
        ...state,
        sessionId: action.id,
        view: { detail, loaded: true },
        pendingApprovals: [],
        approvalDecisions: {},
        resolvedApprovals: [],
        diagnostics: [],
        status: {
          ...EMPTY_STATUS,
          sessionId: action.id,
          threadId: detail?.turns.at(-1)?.threadId ?? null,
          turnCount: detail?.turns.length ?? 0,
          running: detail?.status === 'running'
        }
      }
    }

    case 'set-view':
      return { ...state, view: action.view }

    case 'append-turn': {
      if (state.sessionId !== action.sessionId || !state.view.detail) {
        // 没有载入详情时先建一个最小骨架
        const skeleton: SessionDetail = {
          id: action.sessionId,
          title: action.turn.prompt.slice(0, 60) || '新任务',
          workspace: state.workspace ?? '',
          model: state.settings.model,
          permissionMode: state.settings.permissionMode,
          createdAt: action.turn.startedAt,
          updatedAt: Date.now(),
          status: 'running',
          turns: [action.turn]
        }
        return {
          ...state,
          sessionId: action.sessionId,
          view: { detail: skeleton, loaded: true },
          status: { ...state.status, sessionId: action.sessionId, running: true, startedAt: action.turn.startedAt }
        }
      }
      const detail = state.view.detail
      const turns = [...detail.turns, action.turn]
      return {
        ...state,
        view: { detail: { ...detail, turns, status: 'running', updatedAt: Date.now() }, loaded: true },
        status: { ...state.status, sessionId: action.sessionId, running: true, startedAt: action.turn.startedAt }
      }
    }

    case 'events':
      return reduceEvents(state, action.sessionId, action.events)

    case 'status': {
      const status = action.status
      if (state.status.running && !status.running && state.view.detail) {
        // 主进程宣告结束：收尾当前轮次
        const turns = state.view.detail.turns.slice()
        const lastIndex = turns.length - 1
        const last = turns[lastIndex]
        if (last && last.status === 'running') {
          turns[lastIndex] = { ...last, status: 'completed', endedAt: Date.now() }
        }
        return {
          ...state,
          status,
          view: { detail: { ...state.view.detail, turns, status: 'completed' }, loaded: true },
          sessions: state.sessions.map((session) =>
            session.id === state.status.sessionId
              ? { ...session, status: 'completed', updatedAt: Date.now() }
              : session
          )
        }
      }
      return { ...state, status }
    }

    case 'approval-decision': {
      const decided = state.pendingApprovals.find((request) => request.id === action.approvalId)
      const resolved = decided && !state.resolvedApprovals.some((item) => item.id === decided.id)
        ? [...state.resolvedApprovals, decided]
        : state.resolvedApprovals
      return {
        ...state,
        approvalDecisions: { ...state.approvalDecisions, [action.approvalId]: action.decision },
        pendingApprovals: state.pendingApprovals.filter((request) => request.id !== action.approvalId),
        resolvedApprovals: resolved
      }
    }

    case 'clear-approvals':
      return { ...state, pendingApprovals: [], approvalDecisions: {}, resolvedApprovals: [] }

    case 'env':
      return { ...state, env: action.env, envLoading: action.loading }

    default:
      return state
  }
}

/* ------------------------------------------------------------------ *
 * hook
 * ------------------------------------------------------------------ */

export interface HarnessStore {
  state: HarnessState
  /** 最近一次操作失败的中文提示（用于顶部 toast） */
  error: string | null
  clearError: () => void
  refreshSessions: () => Promise<void>
  loadSession: (id: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  newSession: (workspace?: string) => Promise<SessionSummary | null>
  pickWorkspace: () => Promise<void>
  setWorkspace: (workspace: string | null) => void
  send: (prompt: string, attachments?: AttachmentRef[]) => Promise<boolean>
  cancel: () => Promise<void>
  compactContext: () => Promise<void>
  /** 切换个性化/系统默认外观（主进程读改写，不丢数据） */
  toggleStylePreset: () => Promise<AppSettings | null>
  decideApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
  refreshEnv: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  viewDiff: (paths: string[], label?: string) => Promise<string | null>
}

export function useHarness(): HarnessStore {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)
  const [error, setError] = useState<string | null>(null)

  const stateRef = useRef(state)
  stateRef.current = state

  /* -------- 初始化：设置 + 会话列表 -------- */
  useEffect(() => {
    let alive = true

    const bootstrap = async (): Promise<void> => {
      try {
        const settings = await window.api.getSettings()
        if (!alive) return
        dispatch({ type: 'settings', settings })
        const workspace = settings.recentWorkspaces[0] ?? null
        if (workspace) dispatch({ type: 'workspace', workspace })
      } catch (cause) {
        if (alive) setError(`读取本机设置失败：${describeError(cause)}`)
      }

      try {
        const sessions = await window.api.listSessions()
        if (!alive) return
        dispatch({ type: 'sessions', sessions })
        const first = sessions[0]
        if (first) dispatch({ type: 'workspace', workspace: first.workspace })
      } catch (cause) {
        if (alive) dispatch({ type: 'sessions', sessions: [], error: describeError(cause) })
      }
    }

    void bootstrap()
    return () => {
      alive = false
    }
  }, [])

  /* -------- 订阅流式事件：增量追加 -------- */
  useEffect(() => {
    let queued: { sessionId: string; event: HarnessEvent }[] = []
    let frame: number | null = null

    const flush = (): void => {
      frame = null
      if (queued.length === 0) return
      const batch = queued
      queued = []
      const grouped = new Map<string, HarnessEvent[]>()
      for (const entry of batch) {
        const list = grouped.get(entry.sessionId)
        if (list) list.push(entry.event)
        else grouped.set(entry.sessionId, [entry.event])
      }
      grouped.forEach((events, sessionId) => {
        dispatch({ type: 'events', sessionId, events })
      })
    }

    // 用 rAF 合并同一帧内的高频增量，既保证「增量追加」又不阻塞渲染
    const off = window.api.onEvent((payload) => {
      queued.push(payload)
      if (frame === null) frame = window.requestAnimationFrame(flush)
    })

    return () => {
      off()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [])

  /* -------- 订阅运行态 -------- */
  useEffect(() => {
    const off = window.api.onStatus((status) => {
      dispatch({ type: 'status', status })
    })
    return () => off()
  }, [])

  /* -------- 动作 -------- */

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const sessions = await window.api.listSessions()
      dispatch({ type: 'sessions', sessions })
    } catch (cause) {
      setError(`读取会话列表失败：${describeError(cause)}`)
    }
  }, [])

  const loadSession = useCallback(async (id: string): Promise<void> => {
    try {
      const detail = await window.api.loadSession(id)
      if (!detail) {
        setError('该会话已被删除或无法读取')
        return
      }
      dispatch({ type: 'open-session', id, detail })
      dispatch({ type: 'workspace', workspace: detail.workspace })
    } catch (cause) {
      setError(`载入会话失败：${describeError(cause)}`)
    }
  }, [])

  const removeSession = useCallback(async (id: string): Promise<void> => {
    try {
      const ok = await window.api.deleteSession(id)
      if (!ok) {
        setError('删除会话失败：主进程返回未成功')
        return
      }
      dispatch({ type: 'remove-session', id })
      if (stateRef.current.sessionId === id) {
        dispatch({ type: 'open-session', id: '', detail: null })
        dispatch({ type: 'clear-approvals' })
      }
    } catch (cause) {
      setError(`删除会话失败：${describeError(cause)}`)
    }
  }, [])

  const newSession = useCallback(async (workspace?: string): Promise<SessionSummary | null> => {
    const target = workspace ?? stateRef.current.workspace
    if (!target) {
      setError('请先选择工作目录，再新建任务')
      return null
    }
    try {
      const summary = await window.api.createSession(target)
      dispatch({ type: 'upsert-session', summary })
      dispatch({
        type: 'open-session',
        id: summary.id,
        detail: { ...summary, turns: [] }
      })
      dispatch({ type: 'workspace', workspace: summary.workspace || target })
      setError(null)
      return summary
    } catch (cause) {
      setError(`新建任务失败：${describeError(cause)}`)
      return null
    }
  }, [])

  const pickWorkspace = useCallback(async (): Promise<void> => {
    try {
      const picked = await window.api.pickWorkspace()
      if (!picked) return
      dispatch({ type: 'workspace', workspace: picked })
      const settings = await window.api.saveSettings({ recentWorkspaces: mergeRecent(stateRef.current.settings.recentWorkspaces, picked) })
      dispatch({ type: 'settings', settings })
    } catch (cause) {
      setError(`选择目录失败：${describeError(cause)}`)
    }
  }, [])

  const setWorkspace = useCallback((workspace: string | null): void => {
    dispatch({ type: 'workspace', workspace })
    void window.api
      .saveSettings({ recentWorkspaces: mergeRecent(stateRef.current.settings.recentWorkspaces, workspace) })
      .then((settings) => dispatch({ type: 'settings', settings }))
      .catch(() => undefined)
  }, [])

  const send = useCallback(async (prompt: string, attachments: AttachmentRef[] = []): Promise<boolean> => {
    const trimmed = prompt.trim()
    if (trimmed === '') return false

    const current = stateRef.current
    let sessionId = current.sessionId
    // 工作区必须在创建会话之前确定；createSession 之后 state 还没刷新，不能再去读 ref
    let workspace = current.workspace

    if (!sessionId) {
      const summary = await newSession()
      if (!summary) return false
      sessionId = summary.id
      workspace = summary.workspace || workspace
    } else if (!workspace) {
      workspace = current.view.detail?.workspace ?? null
    }

    if (!workspace) {
      setError('请先选择工作目录，再发送任务')
      return false
    }
    if ((stateRef.current.settings.apiKey ?? '') === '') {
      setError('尚未配置 DeepSeek API Key，无法调用模型：请在「设置」里填写后再发送')
      return false
    }

    const turn: SessionTurn = {
      id: `${sessionId}-local-${Date.now()}`,
      prompt: trimmed,
      startedAt: Date.now(),
      status: 'running',
      events: [],
      // 立刻把附件挂到本轮上，界面不用等主进程回包就能显示 chips
      ...(attachments.length > 0 ? { attachments } : {})
    }
    dispatch({ type: 'append-turn', sessionId, turn })
    setError(null)

    try {
      const result = await window.api.startTask({
        sessionId,
        workspace,
        prompt: trimmed,
        permissionMode: stateRef.current.settings.permissionMode,
        attachments
      })
      if (!result.ok) {
        dispatch({
          type: 'events',
          sessionId,
          events: [{ type: 'turn.failed', message: result.error ?? '任务启动失败（主进程未返回原因）' }]
        })
        setError(result.error ?? '任务启动失败')
        return false
      }
      return true
    } catch (cause) {
      const message = describeError(cause)
      dispatch({ type: 'events', sessionId, events: [{ type: 'turn.failed', message }] })
      setError(`启动任务失败：${message}`)
      return false
    }
  }, [newSession])

  const cancel = useCallback(async (): Promise<void> => {
    const sessionId = stateRef.current.sessionId
    if (!sessionId) return
    try {
      const ok = await window.api.cancelTask(sessionId)
      if (!ok) setError('停止任务未成功：主进程返回 false')
    } catch (cause) {
      setError(`停止任务失败：${describeError(cause)}`)
    }
  }, [])

  /**
   * 切换个性化 / 系统默认外观。
   * 走主进程的读-改-写，渲染层只负责把返回的新设置同步进 state ——
   * 这样即使渲染层内存里的 appearance 比磁盘旧，也不会把个性化数据覆盖掉。
   */
  const toggleStylePreset = useCallback(async (): Promise<AppSettings | null> => {
    try {
      const next = await window.api.toggleStylePreset()
      if (next) dispatch({ type: 'settings', settings: next })
      return next ?? null
    } catch (cause) {
      setError(`切换外观失败：${describeError(cause)}`)
      return null
    }
  }, [])

  /** 手动压缩上下文（只有审批模式的常驻 app-server 支持） */  const compactContext = useCallback(async (): Promise<void> => {
    const sessionId = stateRef.current.sessionId
    if (!sessionId) {
      setError('没有活动会话，无法压缩上下文')
      return
    }
    try {
      const ok = await window.api.compactContext(sessionId)
      if (!ok) {
        setError('压缩上下文未执行：该会话还没有 codex thread，或当前引擎不支持（请用审批模式）')
      }
    } catch (cause) {
      setError(`压缩上下文失败：${describeError(cause)}`)
    }
  }, [])

  const decideApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision): Promise<void> => {
      const sessionId = stateRef.current.sessionId
      if (!sessionId) {
        setError('没有活动会话，无法提交审批决定')
        return
      }
      // 立即禁用按钮，再发请求
      dispatch({ type: 'approval-decision', approvalId, decision })
      try {
        const ok = await window.api.respondApproval(sessionId, approvalId, decision)
        if (!ok) setError('审批决定提交失败：主进程返回 false')
      } catch (cause) {
        setError(`审批决定提交失败：${describeError(cause)}`)
      }
    },
    []
  )

  const saveSettings = useCallback(async (patch: Partial<AppSettings>): Promise<AppSettings | null> => {
    try {
      const settings = await window.api.saveSettings(patch)
      dispatch({ type: 'settings', settings })
      return settings
    } catch (cause) {
      setError(`保存设置失败：${describeError(cause)}`)
      return null
    }
  }, [])

  const refreshEnv = useCallback(async (): Promise<void> => {
    dispatch({ type: 'env', env: stateRef.current.env, loading: true })
    try {
      const env = await window.api.checkEnv()
      dispatch({ type: 'env', env, loading: false })
    } catch (cause) {
      dispatch({ type: 'env', env: null, loading: false })
      setError(`环境自检失败：${describeError(cause)}`)
    }
  }, [])

  const setPermissionMode = useCallback(
    async (mode: PermissionMode): Promise<void> => {
      try {
        const settings = await window.api.setPermissionMode(mode)
        dispatch({ type: 'settings', settings })
      } catch (cause) {
        setError(`切换权限模式失败：${describeError(cause)}`)
      }
    },
    []
  )

  const viewDiff = useCallback(async (paths: string[], label?: string): Promise<string | null> => {
    const workspace = stateRef.current.workspace
    if (!workspace) {
      setError('没有工作目录，无法读取 diff')
      return null
    }
    try {
      const text = await window.api.getDiff(workspace, paths)
      return text
    } catch (cause) {
      setError(`读取 diff 失败：${describeError(cause)}${label ? `（${label}）` : ''}`)
      return null
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const turns = state.view.detail?.turns ?? []

  return useMemo<HarnessStore>(
    () => ({
      state,
      error,
      clearError,
      refreshSessions,
      loadSession,
      removeSession,
      newSession,
      pickWorkspace,
      setWorkspace,
      send,
      cancel,
      compactContext,
      toggleStylePreset,
      decideApproval,
      saveSettings,
      refreshEnv,
      setPermissionMode,
      viewDiff
    }),
    [
      state,
      error,
      clearError,
      refreshSessions,
      loadSession,
      removeSession,
      newSession,
      pickWorkspace,
      setWorkspace,
      send,
      cancel,
      compactContext,
      toggleStylePreset,
      decideApproval,
      saveSettings,
      refreshEnv,
      setPermissionMode,
      viewDiff,
      turns
    ]
  )
}

function mergeRecent(list: string[], value: string | null): string[] {
  if (!value) return list
  return [value, ...list.filter((item) => item !== value)].slice(0, 12)
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}
