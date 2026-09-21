/**
 * 全应用共享类型契约：主进程（core / main）、预加载（preload）、渲染层（renderer）共用。
 * 任何一方改动这里都要同步检查 IPC 通道与 UI 渲染分支。
 */

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * 驱动引擎：
 *  - app-server：常驻 JSON-RPC 服务，支持逐动作审批与补丁预览（实验性协议）
 *  - exec：一次性 `codex exec --json`，权限仅由沙箱模式控制（最稳）
 */
export type HarnessEngine = 'app-server' | 'exec'

export const ENGINE_LABELS: Record<HarnessEngine, string> = {
  'app-server': '审批模式（app-server）',
  exec: '稳定模式（exec）'
}

export const ENGINE_HINTS: Record<HarnessEngine, string> = {
  'app-server': '逐动作审批：允许一次 / 总是允许 / 拒绝；补丁应用前可先看 diff',
  exec: '一次性 codex exec：没有逐动作审批，权限完全由沙箱模式决定'
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问'
}

export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  'read-only': '只能读取文件，任何写入/联网动作都会被沙箱拒绝并回报给模型',
  'workspace-write': '可在工作目录内读写、执行命令，越界动作被拒绝',
  'danger-full-access': '不做沙箱限制，可读写任意路径、访问网络（危险）'
}

export interface AppSettings {
  /** DeepSeek API Key，仅存本地 ~/.codex-desktop/config.json */
  apiKey: string
  /** DeepSeek 模型名 */
  model: string
  /** 采样温度，由内置桥在转发时注入（codex 本身无此配置项） */
  temperature: number
  /**
   * 模型上下文窗口（token）。必须显式声明：codex 不认识 deepseek-* 模型，
   * 会退回兜底元数据（它自己会警告 "this can degrade performance"），
   * 于是压缩时机算错 —— 声明之后 codex 才知道何时该压缩上下文。
   */
  modelContextWindow: number
  /** 自动压缩阈值（token）。0 = 由 codex 依据上面声明的窗口自行决定 */
  autoCompactLimit: number
  /** DeepSeek OpenAI 兼容端点根地址 */
  baseUrl: string
  /** 是否复用 ~/.codex/config.toml（而不是应用私有的 codex-home） */
  reuseUserCodexConfig: boolean
  /**
   * 直连 DeepSeek 原生 Responses API（不使用内置协议桥）。
   * 只有确认该账号/模型支持 /v1/responses 时才可打开，否则会 404。
   */
  useNativeResponses: boolean
  /** 默认权限模式 */
  permissionMode: PermissionMode
  /** 驱动引擎（审批模式 / 稳定模式） */
  engine: HarnessEngine
  /** 界面主题 */
  theme: ThemeMode
  /** 单次任务最大输出 token（0 = 不限制，交给服务端默认） */
  maxOutputTokens: number
  /** 最近使用的工作目录，便于快速切换 */
  recentWorkspaces: string[]
  /** 个性化外观（背景图 + 可替换图片槽位） */
  appearance: AppearanceSettings
}

/* ------------------------------------------------------------------ *
 * 个性化外观
 * ------------------------------------------------------------------ */

/** 可替换的图片槽位 */
export type ImageSlotId = 'brandLogo' | 'emptyState' | 'userAvatar' | 'assistantAvatar' | 'windowIcon'

/** 背景图的自由编辑参数 */
export interface BackgroundTransform {
  /** 缩放 0.5~3，1 = 自适应铺满 */
  zoom: number
  /** 平移，单位是容器尺寸的比例（-1~1） */
  offsetX: number
  offsetY: number
  /** 框选范围，图片归一化坐标 0~1；null = 使用整张图 */
  crop: { x: number; y: number; w: number; h: number } | null
}

export const DEFAULT_TRANSFORM: BackgroundTransform = { zoom: 1, offsetX: 0, offsetY: 0, crop: null }

/** 内置二次元壁纸 */
export type BuiltinWallpaperId = 'starry' | 'sakura' | 'clouds'

export interface WallpaperMeta {
  id: BuiltinWallpaperId
  label: string
  hint: string
}

export const BUILTIN_WALLPAPERS: WallpaperMeta[] = [
  { id: 'starry', label: '星空', hint: '深蓝夜空 + 星屑与流星' },
  { id: 'sakura', label: '樱花', hint: '樱花粉渐变 + 飘落花瓣' },
  { id: 'clouds', label: '云海', hint: '天蓝到粉紫的云海日出' }
]

/** 视觉风格：二次元萌系 / 经典（保持工程感，便于对照与回退） */
export type StylePreset = 'anime' | 'classic'

/** 一张自定义图片（本地上传压缩后的 data:URL，或用户粘贴的远程地址） */
export interface CustomImage {
  /** data:image/... 或 http(s):// 地址 */
  source: string
  kind: 'data' | 'remote'
  /** 上传时的原文件名 */
  name?: string
  /** 估算字节数（base64 已折算），用于配额提示 */
  bytes: number
  width?: number
  height?: number
  addedAt: number
  /** 仅背景使用：缩放 / 平移 / 框选 */
  transform?: BackgroundTransform
}

/** 槽位元数据：抽屉里按这个列表渲染，顺序即展示顺序 */
export interface ImageSlotMeta {
  id: ImageSlotId
  label: string
  hint: string
  /** 是否为本次新增的 UI 元素（默认外观下也可见） */
  added: boolean
}

export const IMAGE_SLOTS: ImageSlotMeta[] = [
  { id: 'brandLogo', label: '品牌标记', hint: '左侧栏顶部的产品标记（默认是机器人图标，文字标题保留）', added: false },
  { id: 'emptyState', label: '空状态插图', hint: '未选工作目录 / 会话为空时中间的大图（默认是 ⌘ 字形）', added: false },
  { id: 'assistantAvatar', label: 'Codex 头像', hint: 'agent 回复气泡旁的头像（默认是 AI 文字徽标）', added: false },
  { id: 'userAvatar', label: '我的头像', hint: '你自己提问气泡旁的头像（默认是 你 文字徽标）', added: false },
  { id: 'windowIcon', label: '窗口 / 任务栏图标', hint: '操作系统窗口与任务栏上的应用图标', added: false }
]

export interface AppearanceSettings {
  /** 自定义背景图；null = 不使用自定义背景 */
  background: CustomImage | null
  /** 内置壁纸；background 存在时优先生效 */
  wallpaper: BuiltinWallpaperId | null
  /** 遮罩强度 0~0.9：越大前景文字越清晰 */
  backgroundOverlay: number
  /** 背景模糊像素 0~24 */
  backgroundBlur: number
  /** 槽位自定义图；缺省 = 用程序自带默认 */
  slots: Partial<Record<ImageSlotId, CustomImage>>
  /** 是否显示对话区头像（关掉则回归纯气泡） */
  showAvatars: boolean
  /** 视觉风格预设 */
  stylePreset: StylePreset
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  background: null,
  wallpaper: null,
  // 根因修复：遮挡层不能太厚。面板自身 alpha 降到约 0.42，遮罩再乘一层，
  // 净透过率约 0.4 —— 既看得见壁纸，又能保住文字对比度。
  backgroundOverlay: 0.22,
  backgroundBlur: 0,
  slots: {},
  showAvatars: true,
  stylePreset: 'anime'
}

/** 上传限制 */
export const IMAGE_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** 压缩后单张图的建议上限（超过就提示） */
export const IMAGE_MAX_STORED_BYTES = 1.5 * 1024 * 1024
/** 所有自定义图的总量警戒线 */
export const IMAGE_TOTAL_WARN_BYTES = 3.5 * 1024 * 1024

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  modelContextWindow: 65536,
  autoCompactLimit: 0,
  baseUrl: 'https://api.deepseek.com/v1',
  reuseUserCodexConfig: false,
  useNativeResponses: false,
  permissionMode: 'workspace-write',
  engine: 'app-server',
  theme: 'dark',
  maxOutputTokens: 0,
  recentWorkspaces: [],
  appearance: DEFAULT_APPEARANCE
}

/** 可选的 DeepSeek 模型（设置页下拉，也允许手填其它模型名） */
export const KNOWN_MODELS = [
  { id: 'deepseek-chat', label: 'deepseek-chat', hint: '通用对话/编码，速度快、成本低' },
  { id: 'deepseek-reasoner', label: 'deepseek-reasoner', hint: '强推理，会输出思考过程' }
] as const

/**
 * 上下文窗口候选值。默认 64K（DeepSeek V3 系历史公开值）——
 * 宁可早压缩也不要在真实请求时超限报错；确认你的模型支持更长上下文后再调大。
 */
export const CONTEXT_WINDOW_OPTIONS = [
  { value: 65536, label: '64K', hint: 'DeepSeek V3 系默认值（保守）' },
  { value: 131072, label: '128K', hint: '较新版本常见' },
  { value: 262144, label: '256K', hint: '需确认你的模型确实支持' }
] as const

/* ------------------------------------------------------------------ *
 * 环境自检
 * ------------------------------------------------------------------ */

export interface EnvCheckItem {
  label: string
  value: string
  ok: boolean
  /** 不可用时给用户的修复建议 */
  hint?: string
}

export interface EnvReport {
  os: string
  items: EnvCheckItem[]
  codexPath: string | null
  codexVersion: string | null
  checkedAt: number
}

/* ------------------------------------------------------------------ *
 * Harness 事件模型（由 core 归一化，UI 只认这一套）
 * ------------------------------------------------------------------ */

export type ToolItemStatus = 'in_progress' | 'completed' | 'failed' | 'denied' | 'unknown'

export interface FileChangeEntry {
  path: string
  /** add / delete / update / unknown */
  kind: string
}

/** 归一化后的 harness 条目 */
export type HarnessItem =
  | { kind: 'agent_message'; id: string; text: string; status: ToolItemStatus }
  | { kind: 'reasoning'; id: string; text: string; status: ToolItemStatus }
  | {
      kind: 'command_execution'
      id: string
      command: string
      output: string
      exitCode: number | null
      status: ToolItemStatus
    }
  | { kind: 'file_change'; id: string; changes: FileChangeEntry[]; status: ToolItemStatus }
  | {
      kind: 'tool_call'
      id: string
      /** 工具名，例如 exec_command / mcp__node_repl.js */
      tool: string
      server?: string
      arguments: string
      output: string
      status: ToolItemStatus
    }
  | { kind: 'todo_list'; id: string; items: { text: string; completed: boolean }[] }
  | { kind: 'web_search'; id: string; query: string; status: ToolItemStatus }
  /** 上下文压缩（codex 自动或用户手动触发） */
  | { kind: 'compaction'; id: string; status: ToolItemStatus }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'unknown'; id: string; rawType: string; raw: unknown }

/* ------------------------------------------------------------------ *
 * 审批（M3 app-server 引擎使用；exec 引擎下以沙箱拒绝形式反馈）
 * ------------------------------------------------------------------ */

export type ApprovalKind = 'command' | 'file_change' | 'permissions'

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny'

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  /** 一句话说明这次要批准什么 */
  title: string
  /** 详情：命令文本、变更文件、理由等 */
  detail: string
  /** command 类：待执行命令 */
  command?: string
  /** file_change 类：受影响的文件路径 */
  paths?: string[]
  /** file_change 类：补丁全文，供 diff 预览 */
  patch?: string
  /** 模型给出的理由（可能为空） */
  reason?: string
  createdAt: number
}

/** 发送给渲染层的流式事件 */
export type HarnessEvent =
  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; decision: ApprovalDecision }
  | { type: 'thread.started'; threadId: string }
  | { type: 'turn.started' }
  | { type: 'item.started'; item: HarnessItem }
  | { type: 'item.updated'; item: HarnessItem }
  | { type: 'item.completed'; item: HarnessItem }
  | { type: 'turn.completed'; usage?: TokenUsage }
  | { type: 'turn.failed'; message: string }
  /** 一轮真正结束（进程可能仍然存活：常驻的 app-server 会保留 thread 以维持上下文） */
  | { type: 'turn.ended'; threadId: string | null }
  /** 上下文占用情况（来自 codex 的用量通知） */
  | { type: 'context.updated'; usedTokens: number | null; window: number | null }
  | { type: 'error'; message: string; fatal: boolean }
  /** 桥/引擎自身的诊断信息（例如权限被拒、重连），展示在活动流里 */
  | { type: 'notice'; level: 'info' | 'warn' | 'denied'; message: string }
  | { type: 'stderr'; text: string }
  | { type: 'exit'; code: number | null; signal: string | null }

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
}

/* ------------------------------------------------------------------ *
 * 会话（任务）持久化
 * ------------------------------------------------------------------ */

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  model: string
  permissionMode: PermissionMode
  createdAt: number
  updatedAt: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** 是否已经持有 codex thread（即后续提问会续接上下文） */
  hasContext?: boolean
}

export interface SessionTurn {
  id: string
  prompt: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  events: HarnessEvent[]
  usage?: TokenUsage
  /** codex 分配的 thread id，用于后续 resume */
  threadId?: string
  /** 本轮提交给 Codex 的文件（用于回看「这轮都给了它什么」） */
  attachments?: AttachmentRef[]
}

export interface SessionDetail extends SessionSummary {
  turns: SessionTurn[]
  /**
   * 本会话对应的 codex thread id。
   * 有了它，后续提问才会续接同一段上下文（app-server 用 thread/resume，
   * exec 用 `codex exec resume <id>`），应用重启后依然可用。
   */
  codexThreadId?: string | null
}

/* ------------------------------------------------------------------ *
 * 运行态状态（渲染层顶部状态条）
 * ------------------------------------------------------------------ */

export interface RunStatus {
  sessionId: string | null
  running: boolean
  /** 当前正在进行的工具名 */
  currentTool: string | null
  threadId: string | null
  startedAt: number | null
  turnCount: number
  /** 本会话是否续接了已有上下文（而非从零开始） */
  hasContext: boolean
  /** 当前上下文窗口内已用 token（来自 codex 的用量通知） */
  contextUsedTokens: number | null
  /** codex 认为的上下文窗口大小 */
  contextWindow: number | null
}

/* ------------------------------------------------------------------ *
 * 附件：用户提交给 Codex 的文件
 * ------------------------------------------------------------------ */

/** 文本可内联 / 图片 / 其它二进制 */
export type AttachmentKind = 'text' | 'image' | 'binary'

export interface AttachmentRef {
  id: string
  /** 展示用文件名 */
  name: string
  /** 用户磁盘上的原始路径 */
  sourcePath: string
  /** 交给 codex 去读取的路径（通常是应用数据目录里的副本，不污染工作区） */
  path: string
  kind: AttachmentKind
  size: number
  /** true = 已拷贝一份；false = 原地引用（文件本来就在工作区里） */
  copied: boolean
  /** 正文是否已内联进提示词 */
  inlined: boolean
  /** 实际内联的字符数 */
  inlineChars: number
  /** 文本文件行数（未统计则为 null） */
  lines: number | null
  /** 给用户看的说明：为什么没内联、被截断了多少等 */
  note?: string
  addedAt: number
}

export interface AddAttachmentsResult {
  attachments: AttachmentRef[]
  /** 被拒绝的文件及原因（不存在、过大、不是文件…） */
  errors: { path: string; reason: string }[]
}

/** 工作区文件树的一项 */
export interface WorkspaceEntry {
  path: string
  /** 相对工作区的路径，用作树的 key 与展示 */
  rel: string
  name: string
  isDir: boolean
  size: number
}

/** 工作区扫描结果：条目 + 是否被上限截断 + 跳过了哪些重目录 */
export interface WorkspaceFileList {
  entries: WorkspaceEntry[]
  truncated: boolean
  skippedDirs: string[]
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

export type ContextTargetKind =
  | 'composer'
  | 'message'
  | 'code'
  | 'command'
  | 'output'
  | 'attachment'
  | 'session'
  | 'workspaceFile'
  | 'workspace'
  | 'none'

/** 渲染层在右键时上报的「光标下是什么」，主进程据此拼菜单 */
export interface ContextTarget {
  kind: ContextTargetKind
  /** 要复制的正文（可能被截断） */
  text?: string
  /** 「复制 X」里的 X，例如「复制代码」 */
  copyLabel?: string
  path?: string
  name?: string
  sessionId?: string
  attachmentId?: string
  editable?: boolean
  selectionText?: string
  truncated?: boolean
  at: number
}

/** 右键菜单里需要渲染层自己执行的动作（剪贴板/打开目录由主进程直接做） */
export interface ContextAction {
  action: 'attach' | 'remove-attachment' | 'clear-composer'
  paths?: string[]
  attachmentId?: string
}

/* ------------------------------------------------------------------ *
 * IPC 契约
 * ------------------------------------------------------------------ */

export interface StartTaskInput {
  sessionId: string
  workspace: string
  prompt: string
  permissionMode: PermissionMode
  /** 随本轮一起提交的文件 */
  attachments?: AttachmentRef[]
}

export interface StartTaskResult {
  ok: boolean
  error?: string
  sessionId?: string
  /** 本次是否续接了上下文 */
  resumed?: boolean
}

/** 启动来源（命令行参数 / 右键菜单 / 直接双击） */
export interface LaunchInfo {
  /** 启动时指定的工作目录（若有） */
  workspace: string | null
  /** 启动时的工作目录 */
  cwd: string
  /** 是否由命令行带路径启动 */
  fromArgument: boolean
}

export interface MainApi {
  /** 环境自检（OS / node / codex / 桥） */
  checkEnv(): Promise<EnvReport>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** 读取 ~/.codex/config.toml 的关键信息（是否存在、是否含自定义 provider） */
  inspectUserCodexConfig(): Promise<{ path: string; exists: boolean; hasModelProvider: boolean; raw: string }>
  /** 弹出系统目录选择框 */
  pickWorkspace(): Promise<string | null>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<SessionDetail | null>
  deleteSession(id: string): Promise<boolean>
  createSession(workspace: string): Promise<SessionSummary>
  startTask(input: StartTaskInput): Promise<StartTaskResult>
  cancelTask(sessionId: string): Promise<boolean>
  /** M3：对审批请求做出决定 */
  respondApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<boolean>
  /** 运行中切换权限模式（下次任务生效，或在 app-server 引擎下即时生效） */
  setPermissionMode(mode: PermissionMode): Promise<AppSettings>
  /** 手动压缩当前会话的上下文（app-server 引擎） */
  compactContext(sessionId: string): Promise<boolean>
  /**
   * 在「个性化（二次元）」与「系统默认（经典）」之间切换。
   * 主进程基于磁盘配置做读-改-写，只翻转 stylePreset，**不会清除任何个性化数据**。
   */
  toggleStylePreset(): Promise<AppSettings>
  /** 本次启动的来源信息（用于「在任意文件夹启动」） */
  getLaunchInfo(): Promise<LaunchInfo>
  /** 列出某个工作区的改动文件（git 仓库） */
  listWorkspaceChanges(workspace: string): Promise<{ path: string; kind: string }[]>
  /** 取某次文件改动的 diff 文本 */
  getDiff(workspace: string, paths: string[]): Promise<string>
  /** 手动探测桥/上游连通性 */
  pingBridge(): Promise<{ local: boolean; upstream: boolean; message: string }>
  /**
   * 把磁盘文件登记为附件。
   * 工作区之外的文件会拷贝到应用数据目录（`<APP_DIR>/attachments/<sessionId>/`），
   * 这样既不会污染用户仓库，codex 又能读到。工作区内的文件原地引用。
   */
  addAttachments(paths: string[], sessionId: string | null, workspace: string | null): Promise<AddAttachmentsResult>
  /** 移除附件（删掉拷贝出来的那份；原地引用的不动） */
  removeAttachment(attachment: AttachmentRef): Promise<boolean>
  /** 列出工作区文件（有界遍历，自动跳过 node_modules/.git 之类的重目录） */
  listWorkspaceFiles(workspace: string): Promise<WorkspaceFileList>
  /** 右键时上报光标下的目标，主进程据此弹出对应的原生菜单 */
  setContextTarget(target: ContextTarget): Promise<void>
  /** 诊断用：读回最近一次上报的右键目标（右键菜单是原生菜单，无法用自动化点击，靠它验证上报内容） */
  getContextTarget(): Promise<ContextTarget | null>
  /** 写系统剪贴板 */
  copyText(text: string): Promise<boolean>
  /** 在系统文件管理器中选中该文件 */
  revealPath(path: string): Promise<boolean>
  /** 用系统默认程序打开 */
  openPath(path: string): Promise<boolean>
  /** 订阅右键菜单里需要渲染层执行的动作 */
  onContextAction(listener: (action: ContextAction) => void): () => void
  /**
   * 把拖拽/粘贴拿到的 File 换成真实磁盘路径。
   * Electron 新版本已移除 `File.path`，只能用渲染侧的 webUtils 取。
   */
  pathForFile(file: File): string
  /** 订阅流式事件，返回取消订阅函数 */
  onEvent(listener: (payload: { sessionId: string; event: HarnessEvent }) => void): () => void
  onStatus(listener: (status: RunStatus) => void): () => void
}
