/**
 * `codex exec --json` 的 JSONL 事件 → 应用内部 HarnessEvent。
 *
 * 实测（codex-cli 0.154.0）的事件类型：
 *   thread.started / turn.started / turn.completed / turn.failed / error
 *   item.started / item.updated / item.completed  （item.type 见下）
 * item 类型：agent_message / reasoning / command_execution / file_change /
 *   mcp_tool_call / dynamic_tool_call / todo_list / web_search / error
 */

import type { HarnessEvent, HarnessItem, TokenUsage, ToolItemStatus } from '../shared/types'

export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let buffer = ''
  return {
    push(chunk: string): void {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.trim().length > 0) onLine(line)
        index = buffer.indexOf('\n')
      }
    },
    flush(): void {
      if (buffer.trim().length > 0) onLine(buffer)
      buffer = ''
    }
  }
}

function mapStatus(raw: unknown): ToolItemStatus {
  switch (String(raw ?? '')) {
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'denied':
      return 'denied'
    default:
      return 'unknown'
  }
}

/** exec 引擎的 usage 形状：{input_tokens, cached_input_tokens, output_tokens, ...} */
export function mapExecUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
  const inputTokens = num(usage.input_tokens)
  const outputTokens = num(usage.output_tokens)
  const total = num(usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  return {
    inputTokens,
    outputTokens,
    totalTokens: total,
    cachedInputTokens: num(usage.cached_input_tokens)
  }
}

export function mapItem(raw: unknown): HarnessItem {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = String(item.id ?? `item_${Math.random().toString(36).slice(2, 10)}`)
  const type = String(item.type ?? '')
  const status = mapStatus(item.status)

  switch (type) {
    case 'agent_message':
      return { kind: 'agent_message', id, text: String(item.text ?? ''), status: status === 'unknown' ? 'completed' : status }

    case 'reasoning':
      return { kind: 'reasoning', id, text: String(item.text ?? ''), status: status === 'unknown' ? 'completed' : status }

    case 'command_execution':
      return {
        kind: 'command_execution',
        id,
        command: String(item.command ?? ''),
        output: String(item.aggregated_output ?? ''),
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status
      }

    case 'file_change': {
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : []
      return {
        kind: 'file_change',
        id,
        changes: changes.map((c) => ({ path: String(c.path ?? ''), kind: String(c.kind ?? 'unknown') })),
        status
      }
    }

    case 'mcp_tool_call':
    case 'dynamic_tool_call':
    case 'tool_call': {
      const args = item.arguments ?? {}
      let argsText: string
      try {
        argsText = typeof args === 'string' ? args : JSON.stringify(args, null, 2)
      } catch {
        argsText = String(args)
      }
      const output =
        typeof item.output === 'string'
          ? item.output
          : typeof item.result === 'string'
            ? item.result
            : item.result
              ? JSON.stringify(item.result, null, 2)
              : ''
      return {
        kind: 'tool_call',
        id,
        tool: String(item.tool ?? item.name ?? type),
        server: item.server === undefined ? undefined : String(item.server),
        arguments: argsText,
        output,
        status
      }
    }

    case 'todo_list': {
      const rawItems = Array.isArray(item.items) ? (item.items as Record<string, unknown>[]) : []
      return {
        kind: 'todo_list',
        id,
        items: rawItems.map((t) => ({ text: String(t.text ?? t.title ?? ''), completed: Boolean(t.completed) }))
      }
    }

    case 'web_search':
      return { kind: 'web_search', id, query: String(item.query ?? ''), status }

    case 'error':
      return { kind: 'error', id, message: String(item.message ?? '') }

    default:
      return { kind: 'unknown', id, rawType: type || '(空)', raw: item }
  }
}

/** 这些是 codex 的良性提示，不该在 UI 里报成错误 */
const BENIGN_ERROR_PATTERNS: RegExp[] = [
  /Model metadata for .* not found/i,
  /^Reconnecting\.\.\./i
]

function isBenign(message: string): boolean {
  return BENIGN_ERROR_PATTERNS.some((re) => re.test(message))
}

export function mapExecEvent(raw: unknown): HarnessEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const event = raw as Record<string, unknown>
  const type = String(event.type ?? '')

  switch (type) {
    case 'thread.started':
      return { type: 'thread.started', threadId: String(event.thread_id ?? '') }

    case 'turn.started':
      return { type: 'turn.started' }

    case 'turn.completed':
      return { type: 'turn.completed', usage: mapExecUsage(event.usage) }

    case 'turn.failed': {
      const error = (event.error ?? {}) as Record<string, unknown>
      return { type: 'turn.failed', message: String(error.message ?? '任务失败') }
    }

    case 'error': {
      const message = String(event.message ?? '')
      if (isBenign(message)) return { type: 'notice', level: 'warn', message }
      return { type: 'error', message, fatal: false }
    }

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const rawItem = event.item
      const itemType = String((rawItem as Record<string, unknown> | undefined)?.type ?? '')
      if (itemType === 'error') {
        const message = String((rawItem as Record<string, unknown>).message ?? '')
        if (isBenign(message)) return { type: 'notice', level: 'warn', message }
      }
      const item = mapItem(rawItem)
      if (type === 'item.started') return { type: 'item.started', item }
      if (type === 'item.updated') return { type: 'item.updated', item }
      return { type: 'item.completed', item }
    }

    default:
      return null
  }
}
