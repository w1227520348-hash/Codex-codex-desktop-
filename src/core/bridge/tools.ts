/**
 * 工具名双向映射。
 *
 * Codex 发给 /v1/responses 的 tools 里存在非 function 类型：
 *   - { type: 'function', name, description, strict, parameters }
 *   - { type: 'namespace', name, description, tools: [ ...function... ] }   ← 分组工具
 *   - { type: 'custom', name, description, format }                          ← 自由格式工具
 *   - { type: 'web_search', external_web_access }                            ← 内置工具，DeepSeek 无对应能力
 *
 * Chat Completions 的 function name 必须匹配 ^[a-zA-Z0-9_-]{1,64}$（不允许点号），
 * 所以 namespace 工具要扁平化成 `ns__tool`，回程再还原成 { name, namespace }。
 */

export interface ToolEntry {
  /** 发给 DeepSeek 的函数名（已净化） */
  chatName: string
  /** Codex 期望的裸工具名 */
  name: string
  /** Codex 期望的命名空间（如果有） */
  namespace?: string
  /** function = 普通函数；custom = 自由格式工具（只有一个 input 字符串参数） */
  kind: 'function' | 'custom'
}

export interface ToolNameMap {
  /** Codex 侧标识（有 namespace 时为 "ns.name"，否则为 "name"）→ 条目 */
  byOriginal: Map<string, ToolEntry>
  /** 发给 DeepSeek 的函数名 → 条目 */
  byChatName: Map<string, ToolEntry>
  /** 被丢弃的工具类型（用于诊断，例如 web_search） */
  dropped: string[]
}

const INVALID_CHARS = /[^a-zA-Z0-9_-]/g
const MAX_NAME_LEN = 64

export function sanitizeName(raw: string): string {
  const cleaned = String(raw ?? '').replace(INVALID_CHARS, '_')
  const trimmed = cleaned.length > MAX_NAME_LEN ? cleaned.slice(0, MAX_NAME_LEN) : cleaned
  return trimmed.length === 0 ? 'tool' : trimmed
}

function originalKey(name: string, namespace?: string | null): string {
  return namespace ? `${namespace}.${name}` : name
}

/**
 * 遍历 Codex 的工具声明，建立映射并产出 Chat Completions 的 tools 数组。
 */
export function buildTools(rawTools: unknown): { tools: ChatTool[]; map: ToolNameMap } {
  const map: ToolNameMap = { byOriginal: new Map(), byChatName: new Map(), dropped: [] }
  const tools: ChatTool[] = []
  const used = new Set<string>()

  const uniqueChatName = (base: string): string => {
    let candidate = sanitizeName(base)
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
    for (let i = 2; i < 1000; i++) {
      const suffix = `_${i}`
      const trimmed = candidate.slice(0, MAX_NAME_LEN - suffix.length) + suffix
      if (!used.has(trimmed)) {
        used.add(trimmed)
        return trimmed
      }
    }
    const fallback = `${candidate.slice(0, 55)}_${Date.now() % 1000}`
    used.add(fallback)
    return fallback
  }

  const register = (entry: ToolEntry, chatTool: ChatTool): void => {
    map.byOriginal.set(originalKey(entry.name, entry.namespace), entry)
    map.byChatName.set(entry.chatName, entry)
    tools.push(chatTool)
  }

  const addFunction = (fn: Record<string, unknown>, namespace?: string): void => {
    const name = String(fn.name ?? '')
    if (!name) return
    const chatName = uniqueChatName(namespace ? `${namespace}__${name}` : name)
    const entry: ToolEntry = { chatName, name, namespace, kind: 'function' }
    const parameters =
      fn.parameters && typeof fn.parameters === 'object'
        ? (fn.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} }
    register(entry, {
      type: 'function',
      function: {
        name: chatName,
        description: typeof fn.description === 'string' ? fn.description : undefined,
        parameters
      }
    })
  }

  const addCustom = (fn: Record<string, unknown>, namespace?: string): void => {
    const name = String(fn.name ?? '')
    if (!name) return
    const chatName = uniqueChatName(namespace ? `${namespace}__${name}` : name)
    const entry: ToolEntry = { chatName, name, namespace, kind: 'custom' }
    // 自由格式工具在 Chat Completions 里退化成「单个字符串入参」
    register(entry, {
      type: 'function',
      function: {
        name: chatName,
        description:
          (typeof fn.description === 'string' ? fn.description : '') +
          '\n\n（本工具接受一段自由格式文本，请把它作为 input 字段的字符串传入）',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '该工具的完整输入文本' }
          },
          required: ['input'],
          additionalProperties: false
        }
      }
    })
  }

  if (Array.isArray(rawTools)) {
    for (const raw of rawTools) {
      if (!raw || typeof raw !== 'object') continue
      const tool = raw as Record<string, unknown>
      const type = String(tool.type ?? '')
      if (type === 'function') {
        addFunction(tool)
      } else if (type === 'custom') {
        addCustom(tool)
      } else if (type === 'namespace') {
        const namespace = String(tool.name ?? '')
        const nested = Array.isArray(tool.tools) ? (tool.tools as Record<string, unknown>[]) : []
        for (const child of nested) {
          const childType = String(child.type ?? '')
          if (childType === 'custom') addCustom(child, namespace)
          else addFunction(child, namespace)
        }
      } else {
        // web_search 等内置工具：DeepSeek 无对应能力，直接不声明
        map.dropped.push(type || 'unknown')
      }
    }
  }

  return { tools, map }
}

/** 把 Codex 侧的工具名解析成条目 */
export function lookupByOriginal(
  map: ToolNameMap,
  name: string,
  namespace?: string | null
): ToolEntry | undefined {
  if (namespace) {
    const hit = map.byOriginal.get(`${namespace}.${name}`)
    if (hit) return hit
  }
  const direct = map.byOriginal.get(name)
  if (direct) return direct
  // 退化：扫一遍找裸名匹配
  for (const entry of map.byOriginal.values()) {
    if (entry.name === name && (!namespace || entry.namespace === namespace)) return entry
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Chat Completions 侧的最小类型
 * ------------------------------------------------------------------ */

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

export interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}
