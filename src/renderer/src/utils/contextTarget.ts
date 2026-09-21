/**
 * 右键目标的采集与上报。
 *
 * 主进程的原生菜单拿不到「光标下是哪个元素」，所以必须在渲染层先认出来再上报。
 * 采集时机选 **mousedown（右键）**：它严格早于 contextmenu，
 * 而主进程的 context-menu 事件是由渲染层这次右键触发的 ——
 * 只在 contextmenu 里上报会有竞态，菜单可能按上一个目标弹出来。
 */

import type { ContextTarget, ContextTargetKind } from '@shared/types'

/** 上报正文上限；超出则截断，并在菜单里注明（不假装复制到了全文） */
export const MAX_CONTEXT_TEXT = 200_000

const TEXT_KINDS = new Set<ContextTargetKind>(['message', 'code', 'command', 'output'])

/** 各类型的默认「复制 X」文案 */
const COPY_LABELS: Partial<Record<ContextTargetKind, string>> = {
  message: '复制这条消息',
  code: '复制代码',
  command: '复制命令',
  output: '复制输出'
}

/** 这些类型的 path 用当前工作区兜底（菜单里有「复制工作目录」） */
const WORKSPACE_PATH_KINDS = new Set<ContextTargetKind>(['message', 'command', 'workspace'])

export interface ContextEnvironment {
  sessionId: string | null
  workspace: string | null
  selectionText?: string
}

/** 从 DOM 事件里解析出右键目标；没有 data-ctx 祖先时返回 null（主进程就不会弹菜单） */
export function contextTargetFromDom(
  domTarget: EventTarget | null,
  env: ContextEnvironment
): ContextTarget | null {
  if (!(domTarget instanceof HTMLElement)) return null
  const host = domTarget.closest('[data-ctx]')
  if (!(host instanceof HTMLElement)) return null

  const kind = (host.dataset.ctx ?? 'none') as ContextTargetKind
  const target: ContextTarget = { kind, at: Date.now() }

  if (TEXT_KINDS.has(kind)) {
    // 优先用显式声明的原文（代码块给的是未转义的源码，比 innerText 更准）
    const declared = host.dataset.ctxText
    const raw = declared !== undefined && declared !== '' ? declared : (host.innerText ?? '')
    if (raw.length > MAX_CONTEXT_TEXT) {
      target.text = raw.slice(0, MAX_CONTEXT_TEXT)
      target.truncated = true
    } else {
      target.text = raw
    }
    const label = COPY_LABELS[kind]
    if (label !== undefined) target.copyLabel = label
  }

  const path = host.dataset.path ?? (WORKSPACE_PATH_KINDS.has(kind) ? (env.workspace ?? '') : '')
  if (path !== '') target.path = path
  if (host.dataset.name) target.name = host.dataset.name
  if (host.dataset.sessionId ?? env.sessionId) target.sessionId = host.dataset.sessionId ?? env.sessionId ?? undefined
  if (host.dataset.attachmentId) target.attachmentId = host.dataset.attachmentId

  const selection = env.selectionText ?? ''
  if (selection !== '') target.selectionText = selection

  return target
}

/** 上报给主进程；没有 api 时（纯渲染层测试）静默跳过 */
export function publishContextTarget(target: ContextTarget | null): void {
  if (target === null) return
  void window.api?.setContextTarget(target)
}

/** mousedown / contextmenu 共用的处理入口 */
export function handleContextProbe(event: {
  button?: number
  target: EventTarget | null
}, env: ContextEnvironment): void {
  // button 为 2 才是右键；键盘唤出菜单时没有 button，也照样采集
  if (typeof event.button === 'number' && event.button !== 2) return
  publishContextTarget(contextTargetFromDom(event.target, env))
}
