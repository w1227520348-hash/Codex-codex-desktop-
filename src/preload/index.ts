import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  AttachmentRef,
  ContextAction,
  ContextTarget,
  HarnessEvent,
  MainApi,
  PermissionMode,
  RunStatus,
  StartTaskInput
} from '../shared/types'

/**
 * 通过 contextBridge 暴露受控 API；渲染层拿不到 Node，也拿不到 ipcRenderer 本体。
 * 订阅函数在 preload 内维护监听集合，返回的取消订阅闭包不会被序列化问题影响。
 */

const eventListeners = new Set<(payload: { sessionId: string; event: HarnessEvent }) => void>()
const statusListeners = new Set<(status: RunStatus) => void>()
const contextActionListeners = new Set<(action: ContextAction) => void>()

ipcRenderer.on('harness:event', (_event, payload: { sessionId: string; event: HarnessEvent }) => {
  for (const listener of [...eventListeners]) {
    try {
      listener(payload)
    } catch (error) {
      console.error('[preload] 事件监听器异常：', error)
    }
  }
})

ipcRenderer.on('harness:status', (_event, status: RunStatus) => {
  for (const listener of [...statusListeners]) {
    try {
      listener(status)
    } catch (error) {
      console.error('[preload] 状态监听器异常：', error)
    }
  }
})

ipcRenderer.on('context:action', (_event, action: ContextAction) => {
  for (const listener of [...contextActionListeners]) {
    try {
      listener(action)
    } catch (error) {
      console.error('[preload] 右键动作监听器异常：', error)
    }
  }
})

const api: MainApi = {
  checkEnv: () => ipcRenderer.invoke('env:check'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:save', patch),
  inspectUserCodexConfig: () => ipcRenderer.invoke('settings:inspectUserCodex'),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id: string) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  createSession: (workspace: string) => ipcRenderer.invoke('sessions:create', workspace),
  startTask: (input: StartTaskInput) => ipcRenderer.invoke('task:start', input),
  cancelTask: (sessionId: string) => ipcRenderer.invoke('task:cancel', sessionId),
  respondApproval: (sessionId: string, approvalId: string, decision) =>
    ipcRenderer.invoke('approval:respond', sessionId, approvalId, decision),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke('settings:setPermissionMode', mode),
  compactContext: (sessionId: string) => ipcRenderer.invoke('context:compact', sessionId),
  toggleStylePreset: () => ipcRenderer.invoke('appearance:toggleStyle'),
  getLaunchInfo: () => ipcRenderer.invoke('launch:info'),
  listWorkspaceChanges: (workspace: string) => ipcRenderer.invoke('workspace:changes', workspace),
  getDiff: (workspace: string, paths: string[]) => ipcRenderer.invoke('workspace:diff', workspace, paths),
  pingBridge: () => ipcRenderer.invoke('bridge:ping'),
  addAttachments: (paths: string[], sessionId: string | null, workspace: string | null) =>
    ipcRenderer.invoke('attachments:add', paths, sessionId, workspace),
  removeAttachment: (attachment: AttachmentRef) => ipcRenderer.invoke('attachments:remove', attachment),
  listWorkspaceFiles: (workspace: string) => ipcRenderer.invoke('workspace:listFiles', workspace),
  setContextTarget: (target: ContextTarget) => ipcRenderer.invoke('context:set', target),
  getContextTarget: () => ipcRenderer.invoke('context:get'),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:copy', text),
  revealPath: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  openPath: (target: string) => ipcRenderer.invoke('shell:open', target),
  onContextAction: (listener) => {
    contextActionListeners.add(listener)
    return () => {
      contextActionListeners.delete(listener)
    }
  },
  /**
   * 拖拽/粘贴进来的 File 对象在 Electron 里已经没有 .path 字段了，
   * 必须用 webUtils 换成真实磁盘路径（这个能力只在渲染侧可用）。
   */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  onEvent: (listener) => {
    eventListeners.add(listener)
    return () => {
      eventListeners.delete(listener)
    }
  },
  onStatus: (listener) => {
    statusListeners.add(listener)
    return () => {
      statusListeners.delete(listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
