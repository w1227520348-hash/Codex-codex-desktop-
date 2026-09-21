import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDiff } from '../core/diff'
import { checkEnvironment } from '../core/envCheck'
import { inspectUserCodexConfig } from '../core/codexHome'
import {
  cleanupSessionAttachments,
  prepareAttachments,
  removeAttachmentCopy
} from '../core/attachments'
import { buildContextMenu, isStale } from '../core/contextMenu'
import type { ContextActionId, MenuItemSpec } from '../core/contextMenu'
import { listWorkspaceFilesResult } from '../core/workspaceFiles'
import { createSession, deleteSession, listSessions, loadSession } from '../core/sessions'
import { loadSettings, rememberWorkspace, saveSettings } from '../core/settings'
import type {
  ApprovalDecision,
  AppSettings,
  AttachmentRef,
  ContextAction,
  ContextTarget,
  LaunchInfo,
  PermissionMode,
  StartTaskInput
} from '../shared/types'
import { Orchestrator } from './orchestrator'

let mainWindow: BrowserWindow | null = null
let orchestrator: Orchestrator | null = null
let launchInfo: LaunchInfo = { workspace: null, cwd: process.cwd(), fromArgument: false }

/**
 * 最近一次右键目标（渲染层在右键时上报）。
 * 原生菜单没法在渲染层读光标下的元素，只能由渲染层先告诉我们「这是什么」。
 */
let lastContextTarget: ContextTarget | null = null

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析启动参数，支持「在任意文件夹启动」：
 *   codex-desktop                  → 用上次的工作目录
 *   codex-desktop .                → 当前目录
 *   codex-desktop D:\some\repo     → 指定目录
 * 打包后 argv[1] 起是用户参数；开发模式（electron out/main/index.js）argv[2] 起。
 */
function parseLaunchInfo(): LaunchInfo {
  const raw = process.argv.slice(app.isPackaged ? 1 : 2)
  const cwd = process.cwd()
  const candidate = raw.find((arg) => !arg.startsWith('-') && isDirectory(path.resolve(cwd, arg)))
  if (!candidate) return { workspace: null, cwd, fromArgument: false }
  return { workspace: path.resolve(cwd, candidate), cwd, fromArgument: true }
}

function emitToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

/** 渲染层上报的正文上限，超了截断（菜单里会注明「仅前 N 字符」） */
const MAX_CONTEXT_TEXT = 200_000

/**
 * 执行菜单动作。
 * 剪贴板 / 打开目录这类系统操作在主进程直接做；
 * 需要改界面状态的（加附件、移除附件、清空输入框）转交给渲染层。
 */
function runContextAction(id: ContextActionId, target: ContextTarget | null): void {
  const targetPath = target?.path ?? ''
  switch (id) {
    case 'copy-text':
      clipboard.writeText(target?.text ?? '')
      return
    case 'copy-path':
    case 'copy-workspace-path':
      if (targetPath !== '') clipboard.writeText(targetPath)
      return
    case 'reveal-path':
    case 'reveal-workspace':
      if (targetPath !== '') shell.showItemInFolder(targetPath)
      return
    case 'open-path':
    case 'open-workspace':
      if (targetPath !== '') void shell.openPath(targetPath)
      return
    case 'attach-paths':
      if (targetPath !== '') emitToRenderer('context:action', { action: 'attach', paths: [targetPath] } satisfies ContextAction)
      return
    case 'remove-attachment':
      if (target?.attachmentId) {
        emitToRenderer('context:action', { action: 'remove-attachment', attachmentId: target.attachmentId } satisfies ContextAction)
      }
      return
    case 'clear-composer':
      emitToRenderer('context:action', { action: 'clear-composer' } satisfies ContextAction)
      return
  }
}

function specToMenuItem(spec: MenuItemSpec): Electron.MenuItemConstructorOptions {
  if (spec.type === 'separator') return { type: 'separator' }
  if (spec.role) return { label: spec.label, role: spec.role, enabled: spec.enabled }
  const action = spec.action
  return {
    label: spec.label,
    enabled: spec.enabled,
    click: () => {
      if (action) runContextAction(action, isStale(lastContextTarget) ? null : lastContextTarget)
    }
  }
}

/**
 * 挂上右键菜单。
 * 编辑类动作交给 Electron 的 role（唯一能可靠作用到输入框与系统剪贴板的做法），
 * 其余按渲染层上报的目标类型动态生成。
 */
function attachContextMenu(): void {
  if (!mainWindow) return
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const target = isStale(lastContextTarget) ? null : lastContextTarget
    const specs = buildContextMenu(target, {
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      editFlags: params.editFlags
    })
    if (specs.length === 0) return
    const menu = Menu.buildFromTemplate(specs.map(specToMenuItem))
    menu.popup(mainWindow ? { window: mainWindow } : undefined)
  })
}

/**
 * 应用「窗口 / 任务栏图标」槽位。
 * 本地上传是 data:URL，可直接解码；粘贴的远程地址需要先下载再解码。
 * 任何失败都静默忽略 —— 图标不是关键路径，不能因为它让设置保存失败。
 */
async function applyWindowIcon(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const slot = loadSettings().appearance.slots.windowIcon
  if (!slot) return
  try {
    if (slot.kind === 'data') {
      const image = nativeImage.createFromDataURL(slot.source)
      if (!image.isEmpty()) mainWindow.setIcon(image)
      return
    }
    const response = await fetch(slot.source)
    if (!response.ok) return
    const buffer = Buffer.from(await response.arrayBuffer())
    const image = nativeImage.createFromBuffer(buffer)
    if (!image.isEmpty()) mainWindow.setIcon(image)
  } catch (error) {
    console.error('[main] 应用窗口图标失败（已忽略）：', error)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    title: 'Codex 驾驶舱',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  attachContextMenu()

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  ipcMain.handle('env:check', async () => {
    const settings = loadSettings()
    return checkEnvironment({
      settings,
      bridgeRunning: orchestrator?.bridgeBaseUrl !== '',
      bridgeBaseUrl: orchestrator?.bridgeBaseUrl ?? '(未启动)',
      bridgeUpstream: orchestrator?.bridgeUpstream ?? settings.baseUrl
    })
  })

  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:save', async (_event, patch: Partial<AppSettings>) => {
    const before = loadSettings()
    const next = saveSettings(patch)
    // key / 模型 / 温度 / 上游地址 / 直连开关变化都要重建桥
    const bridgeRelevant: (keyof AppSettings)[] = ['apiKey', 'model', 'temperature', 'baseUrl', 'maxOutputTokens', 'useNativeResponses']
    if (bridgeRelevant.some((key) => before[key] !== next[key])) {
      try {
        await orchestrator?.restartBridge()
      } catch (error) {
        console.error('[main] 重建协议桥失败：', error)
      }
    }
    // 窗口图标槽位可能变了
    if (before.appearance.slots.windowIcon?.source !== next.appearance.slots.windowIcon?.source) {
      void applyWindowIcon()
    }
    return next
  })

  ipcMain.handle('settings:setPermissionMode', (_event, mode: PermissionMode) => {
    return orchestrator?.setPermissionMode(mode) ?? saveSettings({ permissionMode: mode })
  })

  ipcMain.handle('settings:inspectUserCodex', () => inspectUserCodexConfig())

  ipcMain.handle('workspace:pick', async () => {
    const options = {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      buttonLabel: '选用此目录'
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:changes', async (_event, workspace: string) => {
    return orchestrator?.listWorkspaceChanges(workspace) ?? []
  })

  ipcMain.handle('workspace:diff', async (_event, workspace: string, paths: string[]) => {
    return getDiff(workspace, Array.isArray(paths) ? paths : [])
  })

  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:load', (_event, id: string) => loadSession(id))
  ipcMain.handle('sessions:delete', (_event, id: string) => {
    const ok = deleteSession(id)
    // 会话没了，它的附件副本也没有存在意义（原地引用的文件不会被碰）
    if (ok) cleanupSessionAttachments(id)
    return ok
  })
  ipcMain.handle('sessions:create', (_event, workspace: string) => {
    const settings = loadSettings()
    return createSession(workspace, settings.model, settings.permissionMode)
  })

  ipcMain.handle('task:start', async (_event, input: StartTaskInput) => {
    if (!orchestrator) return { ok: false, error: '应用尚未初始化完成' }
    return orchestrator.startTask(input)
  })

  ipcMain.handle('task:cancel', async (_event, sessionId: string) => {
    return orchestrator?.cancelTask(sessionId) ?? false
  })

  ipcMain.handle('approval:respond', (_event, sessionId: string, approvalId: string, decision: ApprovalDecision) => {
    return orchestrator?.respondApproval(sessionId, approvalId, decision) ?? false
  })

  ipcMain.handle('context:compact', async (_event, sessionId: string) => {
    return (await orchestrator?.compactContext(sessionId)) ?? false
  })

  /**
   * 快捷切换「个性化（二次元）」↔「系统默认（经典）」。
   *
   * 关键：**在主进程里基于磁盘上的最新配置做读-改-写**，只翻转 stylePreset 一个字段。
   * 如果让渲染层拿它内存里的 appearance 拼一个新对象再整体覆盖保存，
   * 一旦渲染层那份数据比磁盘旧（例如别处刚改过、或刚重载），就会把背景图、
   * 头像、框选参数等一起清空 —— 这正是「切换风格把个性化设置弄丢」的成因。
   */
  ipcMain.handle('appearance:toggleStyle', async () => {
    const current = loadSettings()
    const next = current.appearance.stylePreset === 'anime' ? 'classic' : 'anime'
    const saved = saveSettings({ appearance: { ...current.appearance, stylePreset: next } })
    return saved
  })

  ipcMain.handle('launch:info', () => launchInfo)

  /* ---------------- 附件 ---------------- */

  // 外部文件会拷到应用数据目录，避免把用户的仓库搞脏
  ipcMain.handle('attachments:add', (_event, paths: string[], sessionId: string | null, workspace?: string | null) => {
    try {
      return prepareAttachments(Array.isArray(paths) ? paths : [], sessionId ?? null, { workspace: workspace ?? null })
    } catch (error) {
      console.error('[main] 登记附件失败：', error)
      return { attachments: [], errors: [{ path: '', reason: error instanceof Error ? error.message : String(error) }] }
    }
  })

  ipcMain.handle('attachments:remove', (_event, attachment: AttachmentRef) => {
    if (!attachment || typeof attachment.path !== 'string') return false
    return removeAttachmentCopy(attachment)
  })

  ipcMain.handle('workspace:listFiles', (_event, workspace: string) => {
    if (typeof workspace !== 'string' || workspace.trim() === '' || !isDirectory(workspace)) {
      return { entries: [], truncated: false, skippedDirs: [] }
    }
    try {
      return listWorkspaceFilesResult(workspace)
    } catch (error) {
      console.error('[main] 枚举工作区文件失败：', error)
      return { entries: [], truncated: false, skippedDirs: [] }
    }
  })

  /* ---------------- 右键菜单 ---------------- */

  ipcMain.handle('context:set', (_event, target: ContextTarget) => {
    if (!target || typeof target !== 'object') {
      lastContextTarget = null
      return
    }
    const text = typeof target.text === 'string' ? target.text : undefined
    lastContextTarget = {
      ...target,
      at: Date.now(),
      ...(text !== undefined && text.length > MAX_CONTEXT_TEXT
        ? { text: text.slice(0, MAX_CONTEXT_TEXT), truncated: true }
        : {})
    }
  })

  ipcMain.handle('context:get', () => lastContextTarget)

  ipcMain.handle('clipboard:copy', (_event, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
    return true
  })

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    if (typeof target !== 'string' || target.trim() === '') return false
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle('shell:open', async (_event, target: string) => {
    if (typeof target !== 'string' || target.trim() === '') return false
    const message = await shell.openPath(target)
    return message === ''
  })

  ipcMain.handle('bridge:ping', async () => {
    const settings = loadSettings()
    let local = false
    let message = ''

    if (!settings.useNativeResponses) {
      try {
        const handle = await orchestrator?.ensureBridge()
        if (handle) {
          const response = await fetch(`${handle.baseUrl}/health`)
          local = response.ok
        }
      } catch (error) {
        message = `协议桥不可用：${error instanceof Error ? error.message : String(error)}`
      }
    } else {
      local = true
    }

    try {
      const response = await fetch(`${settings.baseUrl}/models`, {
        headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}
      })
      if (response.status === 200) {
        message = `DeepSeek 连通正常，API Key 有效（${settings.baseUrl}）`
        return { local, upstream: true, message }
      }
      if (response.status === 401 || response.status === 403) {
        return { local, upstream: false, message: `DeepSeek 拒绝了这个 API Key（HTTP ${response.status}），请检查设置里的 Key` }
      }
      return { local, upstream: false, message: `DeepSeek 返回 HTTP ${response.status}，请检查 base_url 是否为 ${settings.baseUrl}` }
    } catch (error) {
      return {
        local,
        upstream: false,
        message: `无法连接 ${settings.baseUrl}：${error instanceof Error ? error.message : String(error)}`
      }
    }
  })
}

void app.whenReady().then(async () => {
  launchInfo = parseLaunchInfo()
  // 从命令行/右键菜单带目录启动：把它设为当前工作区，界面启动后直接落在该目录
  if (launchInfo.workspace) {
    try {
      rememberWorkspace(launchInfo.workspace)
    } catch (error) {
      console.error('[main] 记录启动工作区失败：', error)
    }
  }

  orchestrator = new Orchestrator(emitToRenderer)
  registerIpc()
  createWindow()
  void applyWindowIcon()

  // 桥启动失败不应阻塞窗口显示
  if (!loadSettings().useNativeResponses) {
    try {
      await orchestrator.ensureBridge()
    } catch (error) {
      console.error('[main] 协议桥启动失败：', error)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前结束常驻的 codex app-server，避免留下孤儿进程
app.on('before-quit', () => {
  try {
    orchestrator?.disposeEngines()
  } catch {
    /* ignore */
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
