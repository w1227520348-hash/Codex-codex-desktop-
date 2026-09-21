/**
 * 右键菜单的**模板构造**。
 *
 * 为什么单独抽成纯函数：Electron 的原生菜单（Menu.popup）无法用 CDP 点击，
 * 自动化测不到。把「什么目标该出现哪些项」做成纯函数后，就能用单元测试把
 * 每种右键位置的菜单语义钉死；主进程只负责把它翻译成 Electron 的 MenuItem。
 *
 * 编辑类动作（剪切/复制/粘贴/全选/撤销/重做）走 Electron 内置 role，
 * 这是唯一能可靠作用到输入框与系统剪贴板的做法；其余是应用自定义动作。
 */

import type { ContextTarget } from '../shared/types'

/** 应用自定义动作；主进程按此分发 */
export type ContextActionId =
  | 'copy-text'
  | 'copy-path'
  | 'reveal-path'
  | 'open-path'
  | 'attach-paths'
  | 'remove-attachment'
  | 'clear-composer'
  | 'copy-workspace-path'
  | 'open-workspace'
  | 'reveal-workspace'

export type EditorRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'delete'

export interface MenuItemSpec {
  type?: 'separator'
  /** Electron 内置角色 */
  role?: EditorRole
  /** 应用自定义动作 */
  action?: ContextActionId
  label?: string
  enabled?: boolean
}

/** 渲染层上报的目标超过这个时间就认为已过期（避免菜单弹在旧目标上） */
export const TARGET_STALE_MS = 5000

export function isStale(target: ContextTarget | null, now: number = Date.now()): boolean {
  if (!target) return true
  return now - target.at > TARGET_STALE_MS
}

export interface NativeMenuContext {
  isEditable: boolean
  selectionText: string
  editFlags?: {
    canUndo?: boolean
    canRedo?: boolean
    canCut?: boolean
    canCopy?: boolean
    canPaste?: boolean
    canSelectAll?: boolean
    canDelete?: boolean
  }
}

const SEPARATOR: MenuItemSpec = { type: 'separator' }

/**
 * 生成菜单项。
 * @param target 渲染层上报的右键目标（可能为 null → 只有编辑/复制这类通用项）
 * @param native 主进程 context-menu 事件给的权威信息（是否可编辑、选中文本、可用标志）
 */
export function buildContextMenu(target: ContextTarget | null, native: NativeMenuContext): MenuItemSpec[] {
  const items: MenuItemSpec[] = []
  const push = (item: MenuItemSpec): void => {
    items.push(item)
  }
  const pushSeparator = (): void => {
    if (items.length === 0) return
    if (items[items.length - 1].type === 'separator') return
    items.push(SEPARATOR)
  }
  const pushAll = (list: MenuItemSpec[]): void => {
    if (list.length === 0) return
    pushSeparator()
    for (const item of list) items.push(item)
  }

  const flags = native.editFlags ?? {}
  const flag = (value: boolean | undefined): boolean => value !== false
  const selection = native.selectionText ?? ''
  const kind = target && !isStale(target) ? target.kind : 'none'
  const text = target?.text ?? ''
  const hasText = text.trim() !== ''

  /* ---------- 输入框：编辑类 role ---------- */
  if (native.isEditable) {
    push({ role: 'undo', label: '撤销', enabled: flag(flags.canUndo) })
    push({ role: 'redo', label: '重做', enabled: flag(flags.canRedo) })
    pushSeparator()
    push({ role: 'cut', label: '剪切', enabled: flag(flags.canCut) && selection !== '' })
    push({ role: 'copy', label: '复制', enabled: flag(flags.canCopy) && selection !== '' })
    push({ role: 'paste', label: '粘贴', enabled: flag(flags.canPaste) })
    push({ role: 'selectAll', label: '全选', enabled: flag(flags.canSelectAll) })
    if (kind === 'composer') {
      pushSeparator()
      push({ action: 'clear-composer', label: '清空输入框' })
    }
    // 附件动作只看目标是不是附件，不跟 composer 绑在一起：
    // 万一附件 chip 落在某个可编辑区域内，也不该丢掉「移除附件」。
    pushAll(attachmentActions(target))
    return items
  }

  /* ---------- 非输入框：有选中文本就先给「复制」 ---------- */
  if (selection.trim() !== '') {
    push({ role: 'copy', label: '复制选中文本' })
  }

  /* ---------- 按目标类型 ---------- */
  switch (kind) {
    case 'message':
      pushAll([
        { action: 'copy-text', label: copyLabelFor(target, '复制这条消息'), enabled: hasText },
        { action: 'copy-path', label: '复制工作目录', enabled: Boolean(target?.path) }
      ])
      break

    case 'code':
      pushAll([{ action: 'copy-text', label: copyLabelFor(target, '复制代码'), enabled: hasText }])
      break

    case 'command':
      pushAll([
        { action: 'copy-text', label: copyLabelFor(target, '复制命令'), enabled: hasText },
        { action: 'copy-path', label: '复制工作目录', enabled: Boolean(target?.path) }
      ])
      break

    case 'output':
      pushAll([{ action: 'copy-text', label: copyLabelFor(target, '复制输出'), enabled: hasText }])
      break

    case 'attachment':
      pushAll(attachmentActions(target))
      break

    case 'workspaceFile':
      pushAll([
        {
          action: 'attach-paths',
          label: '交给 Codex 理解',
          enabled: Boolean(target?.path)
        },
        { action: 'copy-path', label: '复制路径', enabled: Boolean(target?.path) },
        { action: 'reveal-path', label: '在资源管理器中显示', enabled: Boolean(target?.path) },
        { action: 'open-path', label: '用默认程序打开', enabled: Boolean(target?.path) }
      ])
      break

    case 'session':
      pushAll([
        { action: 'copy-workspace-path', label: '复制工作目录', enabled: Boolean(target?.path) },
        { action: 'reveal-workspace', label: '在资源管理器中显示工作目录', enabled: Boolean(target?.path) },
        { action: 'open-workspace', label: '打开工作目录', enabled: Boolean(target?.path) }
      ])
      break

    case 'workspace':
      pushAll([
        { action: 'copy-path', label: '复制工作目录路径', enabled: Boolean(target?.path) },
        { action: 'reveal-path', label: '在资源管理器中显示', enabled: Boolean(target?.path) }
      ])
      break

    default:
      break
  }

  // 收尾：去掉末尾多余的分隔符
  while (items.length > 0 && items[items.length - 1].type === 'separator') items.pop()
  return items
}

/** 附件相关的通用动作（输入框里挂了附件时也能用） */
function attachmentActions(target: ContextTarget | null): MenuItemSpec[] {
  if (!target || target.kind !== 'attachment') return []
  return [
    { action: 'copy-path', label: '复制文件路径', enabled: Boolean(target.path) },
    { action: 'reveal-path', label: '在资源管理器中显示', enabled: Boolean(target.path) },
    { action: 'remove-attachment', label: '移除这个附件', enabled: Boolean(target.attachmentId) }
  ]
}

/** 内容过长被截断时，把话说清楚，别让用户以为复制到了全文 */
function copyLabelFor(target: ContextTarget | null, fallback: string): string {
  const base = target?.copyLabel ?? fallback
  return target?.truncated ? `${base}（内容过长，仅前 ${Math.round((target.text?.length ?? 0) / 1000)}K 字符）` : base
}
