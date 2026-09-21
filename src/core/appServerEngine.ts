/**
 * app-server 引擎（M3）：驱动 `codex app-server`，支持**逐动作审批**。
 *
 * 与 exec 引擎的区别：
 *   - exec 引擎：一次性 `codex exec --json`，审批策略只能是 never（沙箱拒绝后回喂模型）
 *   - 本引擎：常驻 JSON-RPC 服务，Codex 会在动作前发 `item/commandExecution/requestApproval`
 *     之类的**服务端→客户端请求**，我们把决定回写，从而实现
 *     允许一次 / 总是允许 / 拒绝，并能在补丁应用前把内容拿给用户看。
 *
 * 协议实测（codex-cli 0.154.0）：
 *   - 帧格式：**换行分隔的 JSON**（每行一个 JSON 对象，无 Content-Length 头）
 *   - 握手：initialize → initialized 通知
 *   - 建会话：thread/start {cwd, model, modelProvider, sandbox, approvalPolicy} → {thread:{id}}
 *   - 跑一轮：turn/start {threadId, input:[{type:'text', text}]}
 *   - 打断：turn/interrupt {threadId, turnId}
 *   - 审批请求方法：item/commandExecution/requestApproval、
 *     item/fileChange/requestApproval、item/permissions/requestApproval
 *   - 审批决定：accept / acceptForSession / decline / cancel
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  HarnessEvent,
  HarnessItem,
  PermissionMode,
  TokenUsage,
  ToolItemStatus
} from '../shared/types'
import { codexChildNodeEnv, resolveCodexCli, type CodexCli } from './codexCli'
import { prepareCodexRuntime, type CodexRuntime } from './codexHome'
import { createLineSplitter } from './eventParser'

interface RpcError {
  code: number
  message: string
  data?: unknown
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: RpcError
}

export interface AppServerTaskOptions {
  workspace: string
  prompt: string
  permissionMode: PermissionMode
  settings: AppSettings
  bridgeBaseUrl: string
  onEvent: (event: HarnessEvent) => void
  /** 已有 thread id：走 thread/resume 续接同一段上下文 */
  resumeThreadId?: string | null
  /** 应用侧会话 id：用于判断当前 thread 属不属于这个会话，避免串上下文 */
  sessionId?: string
}

const REQUEST_TIMEOUT_MS = 60000
/**
 * thread/start 的超时。
 * 复用用户配置时 app-server 会去拉起用户自己的 MCP server，而它们的启动超时
 * （例如 ~/.codex/config.toml 里的 startup_timeout_sec）可能高达 120s，
 * 用 60s 会把「启动慢」误判成「握手失败」，进而把进程杀掉，只留下一个看不懂的退出码。
 */
const THREAD_START_TIMEOUT_MS = 180000
/** 是否输出 app-server 的启动诊断（argv / cwd / CODEX_HOME / stderr 尾巴） */
const DEBUG_APPSERVER = process.env.CODEX_DESKTOP_DEBUG === '1'
/** 保留多少行 app-server stderr 用于失败诊断 */
const STDERR_TAIL_LINES = 30
const STDERR_NOISE: RegExp[] = [/^Reading additional input from stdin\.\.\.$/i, /^\s*$/]

/** 审批策略：danger-full-access 下没有任何东西需要批准 */
function approvalPolicyFor(mode: PermissionMode): string {
  return mode === 'danger-full-access' ? 'never' : 'on-request'
}

function mapV2Status(raw: unknown): ToolItemStatus {
  switch (String(raw ?? '')) {
    case 'inProgress':
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'declined':
    case 'denied':
      return 'denied'
    default:
      return 'unknown'
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function changeEntries(raw: unknown): { path: string; kind: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const filePath = String(record.path ?? record.file ?? record.filename ?? '')
    const kind = String(record.kind ?? record.type ?? record.changeKind ?? 'unknown')
    return { path: filePath, kind }
  })
}

/** v2 ThreadItem（camelCase）→ 应用内部 HarnessItem */
export function mapV2Item(raw: unknown): HarnessItem | null {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = String(item.id ?? `item_${Math.random().toString(36).slice(2, 10)}`)
  const type = String(item.type ?? '')
  const status = mapV2Status(item.status)

  switch (type) {
    case 'agentMessage':
      return { kind: 'agent_message', id, text: String(item.text ?? ''), status: status === 'unknown' ? 'completed' : status }

    case 'reasoning': {
      const text = asText(item.summary) || asText(item.content)
      return { kind: 'reasoning', id, text, status: status === 'unknown' ? 'completed' : status }
    }

    case 'commandExecution':
      return {
        kind: 'command_execution',
        id,
        command: String(item.command ?? ''),
        output: String(item.aggregatedOutput ?? ''),
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        status
      }

    case 'fileChange':
      return { kind: 'file_change', id, changes: changeEntries(item.changes), status }

    case 'mcpToolCall': {
      const args = item.arguments ?? {}
      return {
        kind: 'tool_call',
        id,
        tool: String(item.tool ?? 'mcp'),
        server: item.server === undefined ? undefined : String(item.server),
        arguments: safeStringify(args),
        output: item.error ? String((item.error as Record<string, unknown>).message ?? '') : safeStringify(item.result ?? ''),
        status
      }
    }

    case 'dynamicToolCall':
      return {
        kind: 'tool_call',
        id,
        tool: item.namespace ? `${String(item.namespace)}.${String(item.tool ?? '')}` : String(item.tool ?? ''),
        arguments: safeStringify(item.arguments ?? {}),
        output: safeStringify(item.contentItems ?? ''),
        status
      }

    case 'functionCallOutput':
      return {
        kind: 'tool_call',
        id,
        tool: item.namespace ? `${String(item.namespace)}.${String(item.name ?? '')}` : String(item.name ?? 'function'),
        arguments: '',
        output: String(item.output ?? ''),
        status
      }

    case 'webSearch':
      return { kind: 'web_search', id, query: String(item.query ?? ''), status }

    case 'plan': {
      const lines = String(item.text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      return {
        kind: 'todo_list',
        id,
        items: lines.map((line) => ({
          text: line.replace(/^[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, ''),
          completed: /^[-*]\s*\[[xX]\]/.test(line)
        }))
      }
    }

    case 'contextCompaction':
      return { kind: 'compaction', id, status: status === 'unknown' ? 'completed' : status }

    case 'imageView':
      return { kind: 'tool_call', id, tool: 'view_image', arguments: String(item.path ?? ''), output: '', status }

    default:
      return { kind: 'unknown', id, rawType: type || '(空)', raw: item }
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractPathsFromPatch(patch: string): string[] {
  const paths = new Set<string>()
  for (const match of patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) paths.add(match[1].trim())
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\//gm)) paths.add(match[1].trim())
  return [...paths].slice(0, 20)
}

interface UsageBreakdown {
  input: number
  output: number
  total: number
  cached: number
}

/**
 * app-server 的用量结构是 `{ last, total, modelContextWindow }`，
 * 其中 last/total 各自是 TokenUsageBreakdown（inputTokens/outputTokens/totalTokens/cachedInputTokens）。
 */
function readBreakdown(raw: unknown): UsageBreakdown | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  const input = num(record.inputTokens)
  const output = num(record.outputTokens)
  return {
    input,
    output,
    total: num(record.totalTokens) || input + output,
    cached: num(record.cachedInputTokens)
  }
}

function toTokenUsage(breakdown: UsageBreakdown): TokenUsage {
  return {
    inputTokens: breakdown.input,
    outputTokens: breakdown.output,
    totalTokens: breakdown.total,
    cachedInputTokens: breakdown.cached
  }
}

export class AppServerEngine {
  private child: ChildProcess | null = null
  private options: AppServerTaskOptions | null = null
  private nextRequestId = 1
  private readonly inflight = new Map<
    number,
    { resolve: (value: RpcMessage['result']) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly pendingApprovals = new Map<string, { rpcId: number | string }>()
  private threadId: string | null = null
  /** 当前 thread 属于哪个应用侧会话（防止 A 会话的上下文串到 B 会话） */
  private threadSessionId: string | null = null
  private turnId: string | null = null
  private turnSettled: (() => void) | null = null
  private cancelled = false
  private turnStarted = false
  /** 本轮累计用量 */
  private turnUsage: TokenUsage | undefined
  /** 跨轮的 total 游标：用增量法算准每一轮的用量 */
  private usageCursor: UsageBreakdown | null = null
  private lastTurnDiff = ''
  private readonly textByItem = new Map<string, string>()
  private readonly outputByItem = new Map<string, string>()
  private exitEmitted = false
  /** 是否已经完成 initialize 握手（进程常驻，只做一次） */
  private initialized = false
  /** app-server 最近的 stderr（失败诊断用） */
  private stderrTail: string[] = []
  /** 进程是否由我们主动结束（区分「被我们杀了」与「自己死了」） */
  private killedByUs = false
  /** 最近一次观测到的退出码（null = 未知/未退出） */
  private exitCode: number | null = null
  /** 当前宿主的会话标识（workspace + 关键设置）；换了就要重启进程 */
  private hostKey: string | null = null
  /** codex 报告的上下文占用与窗口大小，供状态条展示 */
  private contextUsedTokens: number | null = null
  private contextWindow: number | null = null

  get isRunning(): boolean {
    return this.child !== null
  }

  get wasCancelled(): boolean {
    return this.cancelled
  }

  get currentThreadId(): string | null {
    return this.threadId
  }

  get contextInfo(): { usedTokens: number | null; window: number | null } {
    return { usedTokens: this.contextUsedTokens, window: this.contextWindow }
  }

  /**
   * 开始一轮任务前同步调用。
   * **只清轮次级状态**：进程与 thread 要留着，否则上下文就断了。
   */
  reset(): void {
    this.cancelled = false
    this.turnStarted = false
    this.turnId = null
    this.turnSettled = null
    this.turnUsage = undefined
    this.lastTurnDiff = ''
    this.textByItem.clear()
    this.outputByItem.clear()
    this.pendingApprovals.clear()
  }

  /** 换会话/换工作区/退出应用时调用：真正结束常驻进程 */
  dispose(): void {
    this.threadId = null
    this.threadSessionId = null
    this.hostKey = null
    this.initialized = false
    this.usageCursor = null
    this.contextUsedTokens = null
    this.contextWindow = null
    this.settleTurn()
    this.shutdown()
  }

  /* ---------------- JSON-RPC 收发 ---------------- */

  private write(payload: RpcMessage): void {
    if (!this.child?.stdin?.writable) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<RpcMessage['result']> {
    const id = this.nextRequestId++
    return new Promise<RpcMessage['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.inflight.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params })
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } })
  }

  /* ---------------- 消息分发 ---------------- */

  private handleLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.options?.onEvent({ type: 'stderr', text: line })
      return
    }

    // 服务端 → 客户端的请求（审批走这里）
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message)
      return
    }

    // 通知
    if (message.method) {
      this.handleNotification(message.method, message.params ?? {})
      return
    }

    // 客户端请求的响应
    if (message.id !== undefined) {
      const pending = this.inflight.get(Number(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.inflight.delete(Number(message.id))
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private handleServerRequest(message: RpcMessage): void {
    const method = String(message.method)
    const params = (message.params ?? {}) as Record<string, unknown>
    const rpcId = message.id as number | string

    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const approvalId = String(params.approvalId ?? `${method}#${String(rpcId)}`)
      const command = Array.isArray(params.command)
        ? (params.command as unknown[]).map((v) => String(v)).join(' ')
        : typeof params.command === 'string'
          ? params.command
          : undefined
      this.pendingApprovals.set(approvalId, { rpcId })
      this.options?.onEvent({
        type: 'approval.request',
        request: {
          id: approvalId,
          kind: 'command',
          title: '请求执行命令',
          detail: [params.reason ? String(params.reason) : '', params.cwd ? `工作目录：${String(params.cwd)}` : '']
            .filter((part) => part.length > 0)
            .join('\n') || 'Codex 请求执行一条命令，请确认是否允许。',
          command,
          reason: params.reason === undefined ? undefined : String(params.reason),
          createdAt: Date.now()
        }
      })
      return
    }

    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const approvalId = String(params.approvalId ?? `${method}#${String(rpcId)}`)
      const patch = typeof params.patch === 'string' ? params.patch : this.lastTurnDiff
      this.pendingApprovals.set(approvalId, { rpcId })
      this.options?.onEvent({
        type: 'approval.request',
        request: {
          id: approvalId,
          kind: 'file_change',
          title: '请求应用文件改动',
          detail: params.reason ? String(params.reason) : 'Codex 请求修改文件，请在右侧 Diff 面板确认内容。',
          paths: extractPathsFromPatch(patch),
          patch,
          reason: params.reason === undefined ? undefined : String(params.reason),
          createdAt: Date.now()
        }
      })
      return
    }

    if (method === 'item/permissions/requestApproval') {
      const approvalId = String(params.approvalId ?? `${method}#${String(rpcId)}`)
      this.pendingApprovals.set(approvalId, { rpcId })
      this.options?.onEvent({
        type: 'approval.request',
        request: {
          id: approvalId,
          kind: 'permissions',
          title: '请求提升权限',
          detail: safeStringify(params.permissions ?? params).slice(0, 1500),
          reason: params.reason === undefined ? undefined : String(params.reason),
          createdAt: Date.now()
        }
      })
      return
    }

    // 其余服务端请求本应用不实现：明确回错误，避免 codex 一直等
    this.respondError(rpcId, -32601, `codex-desktop 暂不支持服务端请求 ${method}`)
    this.options?.onEvent({ type: 'notice', level: 'info', message: `已拒绝 codex 的未支持请求：${method}` })
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const emit = this.options?.onEvent
    if (!emit) return

    // 诊断用：把 codex 实际发来的通知方法名打出来。
    // 协议是实验性的，方法名/结构会随版本漂移 —— 怀疑「界面某块数据不动了」时先看这里。
    if (DEBUG_APPSERVER) {
      const brief = method === 'thread/tokenUsage/updated' ? ` ${safeStringify(params).slice(0, 300)}` : ''
      console.error(`[app-server] ← ${method}${brief}`)
    }

    switch (method) {
      case 'turn/started': {
        const turn = params.turn as Record<string, unknown> | undefined
        if (turn?.id) this.turnId = String(turn.id)
        emit({ type: 'turn.started' })
        break
      }

      case 'item/started': {
        const item = mapV2Item(params.item)
        if (item) emit({ type: 'item.started', item })
        break
      }

      case 'item/completed': {
        const item = mapV2Item(params.item)
        if (item) {
          // 结束时用累积的流式文本兜底（有些实现只在 delta 里给正文）
          if (item.kind === 'agent_message') {
            const accumulated = this.textByItem.get(item.id)
            if (accumulated && accumulated.length > item.text.length) item.text = accumulated
          }
          if (item.kind === 'command_execution') {
            const accumulated = this.outputByItem.get(item.id)
            if (accumulated && accumulated.length > item.output.length) item.output = accumulated
          }
          emit({ type: 'item.completed', item })
        }
        break
      }

      case 'item/agentMessage/delta': {
        const id = String(params.itemId ?? '')
        if (!id) break
        const text = (this.textByItem.get(id) ?? '') + String(params.delta ?? '')
        this.textByItem.set(id, text)
        emit({ type: 'item.updated', item: { kind: 'agent_message', id, text, status: 'in_progress' } })
        break
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const id = String(params.itemId ?? '')
        if (!id) break
        const text = (this.textByItem.get(id) ?? '') + String(params.delta ?? '')
        this.textByItem.set(id, text)
        emit({ type: 'item.updated', item: { kind: 'reasoning', id, text, status: 'in_progress' } })
        break
      }

      case 'item/commandExecution/outputDelta': {
        const id = String(params.itemId ?? '')
        if (!id) break
        const output = (this.outputByItem.get(id) ?? '') + String(params.delta ?? '')
        this.outputByItem.set(id, output)
        emit({
          type: 'item.updated',
          item: { kind: 'command_execution', id, command: '', output, exitCode: null, status: 'in_progress' }
        })
        break
      }

      case 'turn/diff/updated':
      case 'item/fileChange/patchUpdated': {
        const diff = typeof params.diff === 'string' ? params.diff : ''
        if (diff.length > 0) this.lastTurnDiff = diff
        break
      }

      case 'thread/tokenUsage/updated': {
        this.accumulateUsage(params.tokenUsage)
        // 顺带把「上下文占用 / 窗口大小」报给界面，用户能看到自己离压缩还有多远
        const raw = params.tokenUsage as Record<string, unknown> | undefined
        const total = readBreakdown(raw?.total)
        if (total) this.contextUsedTokens = total.total
        const window = typeof raw?.modelContextWindow === 'number' ? raw.modelContextWindow : null
        if (window) this.contextWindow = window
        emit({ type: 'context.updated', usedTokens: this.contextUsedTokens, window: this.contextWindow })
        break
      }

      case 'serverRequest/resolved': {
        const requestId = String(params.requestId ?? '')
        for (const [approvalId, entry] of this.pendingApprovals) {
          if (String(entry.rpcId) === requestId) {
            this.pendingApprovals.delete(approvalId)
            emit({ type: 'approval.resolved', id: approvalId, decision: 'allow_once' })
            break
          }
        }
        break
      }

      case 'turn/completed': {
        const turn = (params.turn ?? {}) as Record<string, unknown>
        const status = String(turn.status ?? 'completed')
        if (status === 'failed') {
          const error = (turn.error ?? {}) as Record<string, unknown>
          emit({ type: 'turn.failed', message: String(error.message ?? '任务失败') })
        } else {
          emit({ type: 'turn.completed', usage: this.turnUsage })
        }
        this.turnUsage = undefined
        this.settleTurn()
        break
      }

      case 'error': {
        const message = String(params.message ?? safeStringify(params))
        emit({ type: 'error', message, fatal: false })
        break
      }

      case 'warning':
      case 'guardianWarning':
      case 'configWarning':
      case 'deprecationNotice': {
        const message = String(params.message ?? safeStringify(params))
        emit({ type: 'notice', level: 'warn', message })
        break
      }

      case 'thread/compacted': {
        emit({ type: 'notice', level: 'info', message: '上下文已压缩（旧对话被摘要，thread 继续沿用）。' })
        // 压缩后累计量会重置，重新建立游标
        this.usageCursor = null
        break
      }

      default:
        // app-server 会推送大量与界面无关的通知（MCP 状态、skills/changed 等），按需忽略
        break
    }
  }

  private settleTurn(): void {
    const settle = this.turnSettled
    this.turnSettled = null
    if (settle) settle()
  }

  /**
   * 累计本轮 token 用量。
   *
   * tokenUsage 给的是 `last`（最近一次请求）和 `total`（本线程累计）。
   * 直接取其中一个都不准：一轮里可能发生多次模型请求。
   * 做法：第一次用 `last`（此时没有基线），之后按 `total` 的增量累加。
   */
  private accumulateUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const usage = raw as Record<string, unknown>
    const total = readBreakdown(usage.total)
    const last = readBreakdown(usage.last)

    if (!this.usageCursor) {
      if (last) this.turnUsage = toTokenUsage(last)
      this.usageCursor = total ?? last
      return
    }
    if (!total) return

    const previous = this.usageCursor
    const accumulated = this.turnUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }
    this.turnUsage = {
      inputTokens: (accumulated.inputTokens ?? 0) + Math.max(0, total.input - previous.input),
      outputTokens: (accumulated.outputTokens ?? 0) + Math.max(0, total.output - previous.output),
      totalTokens: (accumulated.totalTokens ?? 0) + Math.max(0, total.total - previous.total),
      cachedInputTokens: (accumulated.cachedInputTokens ?? 0) + Math.max(0, total.cached - previous.cached)
    }
    this.usageCursor = total
  }

  /**
   * 进程退出处理。
   *
   * 必须带上触发它的 child 做身份校验：dispose() 会先杀掉旧进程、紧接着又 spawn 新进程，
   * 而旧进程的 close 事件是**异步**到达的。如果不校验，旧进程的 close 会把
   * this.child 置空，新进程的句柄就此丢失（表现为：换工作区后第一次任务握手失败、
   * 被静默回退到 exec 引擎）。这类过期事件必须直接忽略。
   */
  private handleExit(source: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child !== source) return

    this.child = null
    this.exitCode = code
    // 只有「进程自己死了」才值得报警：我们自己 taskkill 结束（换工作区/空闲回收/退出应用）是正常路径，
    // 否则每次切换工作区都会刷一条吓人的日志。
    if (!this.killedByUs) {
      console.error(
        `[app-server] 进程自行退出 code=${code} signal=${signal}` +
          (code === 4294967295 ? '（= -1：进程自身 exit(-1)，不是被应用强杀；强杀的码是 1）' : '') +
          (this.stderrTail.length ? `\n[app-server] stderr 末尾:\n${this.stderrTail.slice(-8).join('\n')}` : '\n[app-server] stderr 为空')
      )
    } else if (DEBUG_APPSERVER) {
      console.error(`[app-server] 已由应用主动结束 code=${code}`)
    }
    for (const [, pending] of this.inflight) {
      clearTimeout(pending.timer)
      pending.reject(new Error('app-server 进程已退出'))
    }
    this.inflight.clear()
    // 进程没了，待审批的动作只能视为拒绝，避免界面卡在等待状态
    for (const [approvalId, entry] of this.pendingApprovals) {
      this.options?.onEvent({ type: 'approval.resolved', id: approvalId, decision: 'deny' })
      void entry
    }
    this.pendingApprovals.clear()
    this.settleTurn()
    if (!this.exitEmitted) {
      this.exitEmitted = true
      this.options?.onEvent({ type: 'exit', code, signal })
    }
  }

  /* ---------------- 生命周期 ---------------- */

  /**
   * 启动并跑完一轮。
   * 返回值表示「本次是否由 app-server 引擎负责」：
   *   true  = 正常跑完（或用户取消）
   *   false = 握手阶段就失败，什么都没执行，调用方可以安全回退到 exec 引擎
   */
  async start(options: AppServerTaskOptions): Promise<boolean> {
    this.options = options
    const attached = await this.attach(options)
    if (!attached) return false

    try {
      await this.runTurn(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.cancelled) {
        // 用户取消，不算失败
      } else if (!this.turnStarted) {
        // 轮次都没起来：交给上层回退到 exec 引擎（此时没有任何副作用）
        options.onEvent({ type: 'notice', level: 'warn', message: `启动一轮失败：${message}` })
        this.dispose()
        return false
      } else {
        options.onEvent({ type: 'error', message: `app-server 引擎失败：${message}`, fatal: true })
      }
    }
    return true
  }

  /**
   * 只保证「进程 + thread」就绪，不跑轮次。
   * 手动压缩上下文、以及正常启动一轮，都复用它。
   */
  async attach(options: AppServerTaskOptions): Promise<boolean> {
    this.options = options
    if (this.cancelled) {
      options.onEvent({ type: 'notice', level: 'warn', message: '任务在启动前已被取消。' })
      options.onEvent({ type: 'exit', code: null, signal: 'SIGTERM' })
      return false
    }

    const cli = await resolveCodexCli()
    if (this.cancelled) return false
    if (!cli) {
      options.onEvent({
        type: 'error',
        message: '未找到 codex CLI。请先安装：npm i -g @openai/codex --registry=https://registry.npmmirror.com',
        fatal: true
      })
      options.onEvent({ type: 'exit', code: null, signal: null })
      return false
    }

    const runtime = prepareCodexRuntime({
      settings: options.settings,
      bridgeBaseUrl: options.bridgeBaseUrl,
      workspace: options.workspace
    })

    // 常驻进程：同一宿主（工作区 + 模型/上下文设置 + 桥地址 + CODEX_HOME）复用同一个
    // app-server 实例，thread 一直活着 —— 这就是多轮上下文连贯的来源。
    const hostKey = [
      options.workspace,
      options.settings.model,
      options.settings.modelContextWindow,
      options.settings.autoCompactLimit,
      runtime.codexHome,
      options.bridgeBaseUrl
    ].join('|')

    if (this.child && this.hostKey !== hostKey) {
      options.onEvent({ type: 'notice', level: 'info', message: '工作区或模型配置已变化，正在重建 codex 会话进程…' })
      this.dispose()
    }
    this.hostKey = hostKey

    try {
      if (!this.child) this.spawnProcess(cli, runtime, options)
      await this.ensureThread(options)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.cancelled) {
        // 握手阶段失败：还没有产生任何副作用，交给上层回退到 exec 引擎。
        // 这里必须把「可诊断信息」一起抛出来 —— 只说「握手失败」用户无法自查。
        options.onEvent({
          type: 'notice',
          level: 'warn',
          message: `审批模式（app-server）握手失败：${message}${this.buildDiagnostics(cli, runtime, options)}`
        })
        this.dispose()
      }
      return false
    }
  }

  /**
   * 失败诊断串：把「入口文件 / cwd / CODEX_HOME / 退出码 / stderr 尾巴」拼成一段可读信息。
   *
   * 之所以需要它：app-server 是第三方编译产物（我们无法往里加 console.error），
   * 它自行退出时只会留下一个退出码。实测 4294967295 == -1 表示
   * **进程自己 exit(-1)**，而不是被我们 taskkill 杀掉（强杀的码是 1）。
   */
  private buildDiagnostics(cli: CodexCli, runtime: CodexRuntime, options: AppServerTaskOptions): string {
    const lines = [
      '',
      '── app-server 启动诊断 ──',
      `入口(cjs): ${cli.entry}`,
      `运行时   : ${cli.nodePath}`,
      `cwd      : ${options.workspace}`,
      `CODEX_HOME: ${runtime.codexHome}（${options.settings.reuseUserCodexConfig ? '复用用户配置' : '应用私有配置'}）`,
      `model    : ${options.settings.model} → ${runtime.providerBaseUrl}`,
      `进程状态 : ${this.child ? '仍在运行' : '已退出'}${this.killedByUs ? '（由应用主动结束）' : ''}`,
      this.exitCode === null ? '' : `退出码   : ${this.exitCode}${this.exitCode === -1 || this.exitCode === 4294967295 ? '（即 -1，通常是进程自行 exit(-1)，请看下面的 stderr）' : ''}`
    ]
    if (this.stderrTail.length > 0) {
      lines.push('stderr 末尾:', ...this.stderrTail.slice(-12).map((l) => `  ${l}`))
    } else {
      lines.push('stderr 末尾: （空 —— 若进程自行 exit(-1) 且没有任何输出，多为运行时/原生二进制层面的问题）')
    }
    lines.push(`排查建议: 运行 npm run diagnose:appserver 做一次完整体检（依赖完整性 / 传输方式 / 退出码）`)
    return lines.filter(Boolean).join('\n')
  }

  /** 启动常驻 app-server 进程（仅在需要时调用一次） */
  private spawnProcess(cli: CodexCli, runtime: CodexRuntime, options: AppServerTaskOptions): void {
    const args = [cli.entry, 'app-server', ...runtime.overrides.flatMap((override) => ['-c', override])]
    const env = {
      ...process.env,
      // Electron 里 nodePath 是 electron.exe：不加这个会启动一整套 Chromium，
      // 与父进程抢 userData/Cache 后立刻退出（退出码 -1、stderr 为空，极难自查）
      ...codexChildNodeEnv(cli),
      ...runtime.env,
      CODEX_HOME: runtime.codexHome,
      TERM: 'dumb'
    }
    const child = spawn(cli.nodePath, args, {
      cwd: options.workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.exitEmitted = false
    this.killedByUs = false
    this.exitCode = null
    this.stderrTail = []

    // 这个第三方进程出错时只会留下退出码，所以把启动参数完整打出来，便于自查
    const debugLine = [
      `[app-server] spawn node=${cli.nodePath}`,
      `entry=${cli.entry}`,
      `cwd=${options.workspace}`,
      `CODEX_HOME=${runtime.codexHome}`,
      `model=${options.settings.model}`,
      `upstream=${runtime.providerBaseUrl}`
    ].join(' | ')
    if (DEBUG_APPSERVER) {
      console.error(`${debugLine}\n[app-server] argv: ${args.join(' ')}`)
    }

    const splitter = createLineSplitter((line) => this.handleLine(line))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk))

    const stderrSplitter = createLineSplitter((line) => {
      if (STDERR_NOISE.some((re) => re.test(line))) return
      this.stderrTail.push(line)
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
      options.onEvent({ type: 'stderr', text: line })
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderrSplitter.push(chunk))

    child.on('error', (error) => {
      if (this.child !== child) return
      options.onEvent({ type: 'error', message: `启动 codex app-server 失败：${error.message}`, fatal: true })
      splitter.flush()
      this.handleExit(child, null, null)
    })
    child.on('close', (code, signal) => {
      splitter.flush()
      stderrSplitter.flush()
      this.handleExit(child, code, signal)
    })
  }

  /**
   * 保证 thread 就绪：
   *   有 resumeThreadId 且与当前 thread 不同 → thread/resume（应用重启后也能续上）
   *   当前 thread 还在且没要求换 → 直接复用（上下文天然连贯）
   *   否则 → thread/start 新建
   */
  private async ensureThread(options: AppServerTaskOptions): Promise<void> {
    if (!this.child) throw new Error('app-server 进程不可用')

    if (!this.initialized) {
      await this.request('initialize', {
        clientInfo: { name: 'codex-desktop', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      })
      this.notify('initialized')
      this.initialized = true
    }

    const wanted = options.resumeThreadId ?? null
    // 已经在这个 thread 上（同一会话的连续多轮）→ 直接复用，上下文天然连贯
    if (this.threadId && this.threadId === wanted) return
    // 没有指定要续接的 thread 时，只有「当前 thread 就属于这个会话」才能复用，
    // 否则会把上一个会话的上下文串进来。
    if (this.threadId && !wanted && options.sessionId && this.threadSessionId === options.sessionId) return

    if (wanted) {
      try {
        await this.request('thread/resume', {
          threadId: wanted,
          cwd: options.workspace,
          model: options.settings.model,
          modelProvider: 'deepseek',
          sandbox: options.permissionMode,
          approvalPolicy: approvalPolicyFor(options.permissionMode)
        })
        this.threadId = wanted
        this.threadSessionId = options.sessionId ?? null
        this.usageCursor = null
        options.onEvent({ type: 'notice', level: 'info', message: `已续接上一轮上下文（thread ${wanted.slice(0, 8)}…）` })
        options.onEvent({ type: 'thread.started', threadId: wanted })
        return
      } catch (error) {
        options.onEvent({
          type: 'notice',
          level: 'warn',
          message: `续接上下文失败（${error instanceof Error ? error.message : String(error)}），改为开始一段新上下文。`
        })
        this.threadId = null
      }
    }

    const result = (await this.request(
      'thread/start',
      {
        cwd: options.workspace,
        model: options.settings.model,
        modelProvider: 'deepseek',
        sandbox: options.permissionMode,
        approvalPolicy: approvalPolicyFor(options.permissionMode)
      },
      // 复用用户配置时可能要等它拉起 MCP server（用户配置里常见 startup_timeout_sec=120）
      options.settings.reuseUserCodexConfig ? THREAD_START_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    )) as { thread?: { id?: string } } | undefined

    this.threadId = result?.thread?.id ?? null
    this.threadSessionId = options.sessionId ?? null
    if (!this.threadId) throw new Error('thread/start 没有返回 thread id')
    this.usageCursor = null
    options.onEvent({ type: 'thread.started', threadId: this.threadId })
  }

  /** 在当前 thread 上跑一轮，并等到这一轮结束 */
  private async runTurn(options: AppServerTaskOptions): Promise<void> {
    if (!this.threadId) throw new Error('thread 未就绪')

    const result = (await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: options.prompt }]
    })) as { turn?: { id?: string } } | undefined
    this.turnId = result?.turn?.id ?? null
    this.turnStarted = true

    await new Promise<void>((resolve) => {
      this.turnSettled = resolve
      if (this.cancelled || !this.child) resolve()
    })

    options.onEvent({ type: 'turn.ended', threadId: this.threadId })
  }

  /** 手动压缩上下文（thread/compact/start） */
  async compact(): Promise<boolean> {
    if (!this.child || !this.threadId) return false
    try {
      await this.request('thread/compact/start', { threadId: this.threadId }, 180000)
      this.options?.onEvent({ type: 'notice', level: 'info', message: '已请求压缩上下文。' })
      return true
    } catch (error) {
      this.options?.onEvent({
        type: 'notice',
        level: 'warn',
        message: `压缩上下文失败：${error instanceof Error ? error.message : String(error)}`
      })
      return false
    }
  }

  respondApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pendingApprovals.get(approvalId)
    if (!entry) return false
    this.pendingApprovals.delete(approvalId)
    const wire = decision === 'allow_once' ? 'accept' : decision === 'allow_always' ? 'acceptForSession' : 'decline'
    this.respond(entry.rpcId, { decision: wire })
    this.options?.onEvent({ type: 'approval.resolved', id: approvalId, decision })
    return true
  }

  /** 当前是否有等待用户决定的审批 */
  get hasPendingApprovals(): boolean {
    return this.pendingApprovals.size > 0
  }

  cancel(): void {
    this.cancelled = true
    // 先把待审批的都拒掉，否则 codex 会一直等我们的响应
    for (const [approvalId, entry] of this.pendingApprovals) {
      this.respond(entry.rpcId, { decision: 'cancel' })
      this.options?.onEvent({ type: 'approval.resolved', id: approvalId, decision: 'deny' })
    }
    this.pendingApprovals.clear()

    if (this.threadId && this.turnId) {
      this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10000).catch(() => undefined)
    }
    // 打断一轮**不要**杀进程：thread 要留着，用户接着问才还有上下文。
    // 只有打断迟迟不生效时才强制结束进程兜底。
    setTimeout(() => {
      if (this.turnSettled) {
        this.options?.onEvent({ type: 'notice', level: 'warn', message: '打断超时，已强制结束 codex 会话进程。' })
        this.settleTurn()
        this.dispose()
      }
    }, 8000)
  }

  private shutdown(): void {
    const child = this.child
    if (!child) return
    this.child = null
    // 标记为「我们主动结束」：这样退出码 1/-1 就不会被误读成 app-server 自己崩了
    this.killedByUs = true
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* ignore */
    }
  }
}
