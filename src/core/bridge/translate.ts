/**
 * 请求翻译：Codex 的 Responses 请求体 → DeepSeek 的 Chat Completions 请求体。
 *
 * 已通过抓取 codex-cli 0.154.0 的真实请求确认顶层字段：
 *   model / instructions / input / tools / tool_choice / parallel_tool_calls /
 *   reasoning / store / stream / include / prompt_cache_key / client_metadata
 *
 * input 条目类型：message(role=developer|user|assistant) / function_call /
 *   function_call_output / custom_tool_call / custom_tool_call_output / reasoning / web_search_call
 */

import {
  buildTools,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  lookupByOriginal,
  sanitizeName,
  type ToolNameMap
} from './tools'

export interface TranslationResult {
  messages: ChatMessage[]
  tools: ChatTool[]
  map: ToolNameMap
  /** 请求里出现但被忽略的输入条目类型（诊断用） */
  ignoredInputTypes: string[]
}

interface ContentPart {
  type?: string
  text?: string
  refusal?: string
}

function partsToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      chunks.push(raw)
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const part = raw as ContentPart
    if (typeof part.text === 'string') chunks.push(part.text)
    else if (typeof part.refusal === 'string') chunks.push(part.refusal)
    else if (part.type === 'input_image') chunks.push('[图片]')
  }
  return chunks.join('\n')
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content)) return partsToText(obj.content)
  }
  if (Array.isArray(output)) return partsToText(output)
  if (output == null) return ''
  return JSON.stringify(output)
}

function argumentsToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return '{}'
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

/**
 * 把 Responses 请求体翻译成 Chat Completions 请求体。
 */
export function translateRequest(body: Record<string, unknown>): TranslationResult {
  const { tools, map } = buildTools(body.tools)

  const systemParts: string[] = []
  if (typeof body.instructions === 'string' && body.instructions.trim().length > 0) {
    systemParts.push(body.instructions)
  }

  const messages: ChatMessage[] = []
  const ignoredInputTypes: string[] = []
  let pendingToolCalls: ChatToolCall[] = []

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return
    messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls })
    pendingToolCalls = []
  }

  const pushConversational = (role: 'user' | 'assistant', text: string): void => {
    if (text.length === 0) return
    const last = messages[messages.length - 1]
    // 合并相邻同角色消息：部分 OpenAI 兼容实现不接受连续同角色
    if (last && last.role === role && !last.tool_calls) {
      last.content = `${last.content ?? ''}\n\n${text}`
      return
    }
    messages.push({ role, content: text })
  }

  const input = Array.isArray(body.input) ? body.input : []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const type = String(item.type ?? '')

    switch (type) {
      case 'message': {
        const role = String(item.role ?? 'user')
        const text = partsToText(item.content)
        if (role === 'developer' || role === 'system') {
          systemParts.push(text)
        } else if (role === 'assistant') {
          flushToolCalls()
          pushConversational('assistant', text)
        } else {
          flushToolCalls()
          pushConversational('user', text)
        }
        break
      }

      case 'function_call':
      case 'custom_tool_call': {
        const bareName = String(item.name ?? '')
        const namespace = typeof item.namespace === 'string' ? item.namespace : undefined
        const entry = lookupByOriginal(map, bareName, namespace)
        const args =
          type === 'custom_tool_call'
            ? JSON.stringify({ input: typeof item.input === 'string' ? item.input : '' })
            : argumentsToText(item.arguments)
        pendingToolCalls.push({
          id: String(item.call_id ?? item.id ?? `call_${pendingToolCalls.length}`),
          type: 'function',
          function: { name: entry?.chatName ?? sanitizeName(bareName), arguments: args }
        })
        break
      }

      case 'function_call_output':
      case 'custom_tool_call_output': {
        flushToolCalls()
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? ''),
          content: outputToText(item.output) || '（无输出）'
        })
        break
      }

      case 'reasoning':
        // DeepSeek 不需要回传历史思考内容，直接丢弃（也避免 encrypted_content 依赖）
        break

      default:
        ignoredInputTypes.push(type || '(empty)')
        break
    }
  }
  flushToolCalls()

  if (systemParts.length > 0) {
    messages.unshift({ role: 'system', content: systemParts.join('\n\n') })
  }

  return { messages, tools, map, ignoredInputTypes }
}

/** 组装真正发给 DeepSeek 的请求体 */
export function buildUpstreamBody(
  translation: TranslationResult,
  opts: {
    model: string
    temperature: number
    maxOutputTokens: number
    stream: boolean
    toolChoice?: unknown
  }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: translation.messages,
    stream: opts.stream
  }
  if (translation.tools.length > 0) {
    body.tools = translation.tools
    body.tool_choice = normalizeToolChoice(opts.toolChoice, translation.tools)
  }
  if (Number.isFinite(opts.temperature)) body.temperature = opts.temperature
  if (opts.maxOutputTokens > 0) body.max_output_tokens = opts.maxOutputTokens
  if (opts.stream) body.stream_options = { include_usage: true }
  return body
}

function normalizeToolChoice(choice: unknown, tools: ChatTool[]): unknown {
  if (typeof choice !== 'string' || choice.length === 0) return 'auto'
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  return 'auto'
}
