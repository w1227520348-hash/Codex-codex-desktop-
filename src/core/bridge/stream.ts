/**
 * 回程翻译：DeepSeek 的 Chat Completions SSE 流 → Codex 期望的 Responses SSE 事件流。
 *
 * 事件顺序（Codex 侧观察到的契约）：
 *   response.created
 *   response.output_item.added      (reasoning / message / function_call)
 *   response.reasoning_summary_text.delta | response.output_text.delta
 *   response.function_call_arguments.delta
 *   response.output_item.done
 *   response.completed              (带完整 output[] 与 usage)
 *
 * 策略：
 *   - 正文与思考**增量**下发，保证 Codex 侧（以及最终 UI）看到流式效果
 *   - function_call 的参数**缓冲到收流结束**再下发，因为工具名可能分片到达，
 *     提前 emit added 会发出空名字的条目
 */

import { randomUUID } from 'node:crypto'
import type { ToolNameMap } from './tools'

export type ResponsesEmitter = (eventType: string, payload: Record<string, unknown>) => void

export interface StreamResult {
  output: Record<string, unknown>[]
  usage: Record<string, unknown> | null
  text: string
  failed: boolean
}

interface ReasoningState {
  id: string
  index: number
  text: string
}

interface MessageState {
  id: string
  index: number
  text: string
}

interface ToolCallState {
  id: string
  callId: string
  chatName: string
  args: string
}

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '')}`

/** 增量 SSE 解析器：把字节流切成一个个 data 载荷 */
export class SseParser {
  private buffer = ''
  private dataLines: string[] = []

  push(chunk: string): string[] {
    this.buffer += chunk
    const payloads: string[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) {
        if (this.dataLines.length > 0) {
          payloads.push(this.dataLines.join('\n'))
          this.dataLines = []
        }
      } else if (line.startsWith('data:')) {
        let data = line.slice(5)
        if (data.startsWith(' ')) data = data.slice(1)
        this.dataLines.push(data)
      }
      newlineIndex = this.buffer.indexOf('\n')
    }
    return payloads
  }

  /** 流结束时把残留的最后一个事件吐出来（有些实现不补尾随空行） */
  flush(): string[] {
    const payloads: string[] = []
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ''
      if (line.startsWith('data:')) {
        let data = line.slice(5)
        if (data.startsWith(' ')) data = data.slice(1)
        this.dataLines.push(data)
      }
    }
    if (this.dataLines.length > 0) {
      payloads.push(this.dataLines.join('\n'))
      this.dataLines = []
    }
    return payloads
  }
}

function mapUsage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as Record<string, unknown>
  const pick = (value: unknown): number => (typeof value === 'number' ? value : 0)
  const mapped: Record<string, unknown> = {
    input_tokens: pick(usage.prompt_tokens),
    output_tokens: pick(usage.completion_tokens),
    total_tokens: pick(usage.total_tokens)
  }
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined
  const cached = promptDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens
  if (typeof cached === 'number') mapped.input_tokens_details = { cached_tokens: cached }
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined
  if (completionDetails && typeof completionDetails.reasoning_tokens === 'number') {
    mapped.output_tokens_details = { reasoning_tokens: completionDetails.reasoning_tokens }
  }
  return mapped
}

export class ChatToResponsesTranslator {
  private sequence = 0
  private readonly responseId = newId('resp')
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private readonly output: Record<string, unknown>[] = []
  private reasoning: ReasoningState | null = null
  private message: MessageState | null = null
  private readonly toolCalls = new Map<number, ToolCallState>()
  private usage: Record<string, unknown> | null = null
  private createdEmitted = false
  private finished = false
  private failed = false

  constructor(
    private readonly emit: ResponsesEmitter,
    private readonly map: ToolNameMap,
    private readonly model: string
  ) {}

  private emitEvent(type: string, extra: Record<string, unknown>): void {
    this.sequence += 1
    this.emit(type, { type, sequence_number: this.sequence, ...extra })
  }

  begin(): void {
    if (this.createdEmitted) return
    this.createdEmitted = true
    this.emitEvent('response.created', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'in_progress',
        model: this.model,
        output: []
      }
    })
  }

  /** 处理一个上游 data 载荷（已去掉 "data: " 前缀） */
  handlePayload(payload: string): void {
    const trimmed = payload.trim()
    if (trimmed.length === 0 || trimmed === '[DONE]') return

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }

    if (parsed.error) {
      const err = parsed.error as Record<string, unknown>
      this.fail(String(err.message ?? '上游返回未知错误'))
      return
    }

    if (parsed.usage) {
      const mapped = mapUsage(parsed.usage)
      if (mapped) this.usage = mapped
    }

    const choices = parsed.choices
    if (!Array.isArray(choices) || choices.length === 0) return
    const first = choices[0] as Record<string, unknown>
    const delta = first.delta as Record<string, unknown> | undefined
    if (!delta) return

    const reasoningDelta = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      const state = this.ensureReasoning()
      state.text += reasoningDelta
      this.emitEvent('response.reasoning_summary_text.delta', {
        item_id: state.id,
        output_index: state.index,
        summary_index: 0,
        delta: reasoningDelta
      })
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const state = this.ensureMessage()
      state.text += delta.content
      this.emitEvent('response.output_text.delta', {
        item_id: state.id,
        output_index: state.index,
        content_index: 0,
        delta: delta.content
      })
    }

    const rawToolCalls = delta.tool_calls
    if (Array.isArray(rawToolCalls)) {
      for (const raw of rawToolCalls) {
        if (!raw || typeof raw !== 'object') continue
        const call = raw as Record<string, unknown>
        const index = typeof call.index === 'number' ? call.index : 0
        let state = this.toolCalls.get(index)
        if (!state) {
          state = {
            id: newId('fc'),
            callId: typeof call.id === 'string' && call.id ? call.id : newId('call'),
            chatName: '',
            args: ''
          }
          this.toolCalls.set(index, state)
        }
        if (typeof call.id === 'string' && call.id && state.callId.startsWith('call_')) {
          state.callId = call.id
        }
        const fn = call.function as Record<string, unknown> | undefined
        if (fn) {
          if (typeof fn.name === 'string' && fn.name) state.chatName += fn.name
          if (typeof fn.arguments === 'string') state.args += fn.arguments
        }
      }
    }
  }

  private ensureReasoning(): ReasoningState {
    if (this.reasoning) return this.reasoning
    const index = this.output.length
    const item: Record<string, unknown> = { id: newId('rs'), type: 'reasoning', summary: [] }
    this.output.push(item)
    this.reasoning = { id: String(item.id), index, text: '' }
    this.emitEvent('response.output_item.added', { output_index: index, item })
    return this.reasoning
  }

  private ensureMessage(): MessageState {
    if (this.message) return this.message
    const index = this.output.length
    const item: Record<string, unknown> = {
      id: newId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: []
    }
    this.output.push(item)
    this.message = { id: String(item.id), index, text: '' }
    this.emitEvent('response.output_item.added', { output_index: index, item })
    return this.message
  }

  fail(message: string): void {
    if (this.finished) return
    this.finished = true
    this.failed = true
    this.emitEvent('response.failed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'failed',
        model: this.model,
        output: this.output,
        error: { code: 'upstream_error', message }
      }
    })
  }

  /** 收流结束：补齐所有 done 事件并下发 response.completed */
  finish(): StreamResult {
    if (this.finished) {
      return { output: this.output, usage: this.usage, text: this.message?.text ?? '', failed: this.failed }
    }
    this.finished = true

    if (this.reasoning) {
      const item = this.output[this.reasoning.index]
      const text = this.reasoning.text
      item.summary = text.length > 0 ? [{ type: 'summary_text', text }] : []
      item.content = []
      this.emitEvent('response.output_item.done', { output_index: this.reasoning.index, item })
    }

    if (this.message) {
      const item = this.output[this.message.index]
      const text = this.message.text
      item.status = 'completed'
      item.content = text.length > 0 ? [{ type: 'output_text', text, annotations: [] }] : []
      this.emitEvent('response.output_item.done', { output_index: this.message.index, item })
    }

    const ordered = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])
    for (const [, state] of ordered) {
      const entry = this.map.byChatName.get(state.chatName)
      const bareName = entry?.name ?? state.chatName
      const index = this.output.length
      let item: Record<string, unknown>

      if (entry?.kind === 'custom') {
        let inputText = state.args
        try {
          const parsed = JSON.parse(state.args) as Record<string, unknown>
          if (parsed && typeof parsed.input === 'string') inputText = parsed.input
        } catch {
          /* 保留原始文本 */
        }
        item = {
          id: state.id,
          type: 'custom_tool_call',
          call_id: state.callId,
          name: bareName,
          input: inputText,
          status: 'completed'
        }
      } else {
        item = {
          id: state.id,
          type: 'function_call',
          call_id: state.callId,
          name: bareName,
          arguments: state.args.length > 0 ? state.args : '{}',
          status: 'completed'
        }
      }
      if (entry?.namespace) item.namespace = entry.namespace

      this.output.push(item)
      this.emitEvent('response.output_item.added', {
        output_index: index,
        item: { ...item, status: 'in_progress', arguments: entry?.kind === 'custom' ? undefined : '' }
      })
      if (entry?.kind !== 'custom') {
        this.emitEvent('response.function_call_arguments.delta', {
          item_id: state.id,
          output_index: index,
          delta: String(item.arguments ?? '{}')
        })
      }
      this.emitEvent('response.output_item.done', { output_index: index, item })
    }

    this.emitEvent('response.completed', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'completed',
        model: this.model,
        output: this.output,
        usage: this.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      }
    })

    return { output: this.output, usage: this.usage, text: this.message?.text ?? '', failed: false }
  }

  get isFinished(): boolean {
    return this.finished
  }
}

/**
 * 非流式回退路径：把一次完整的 Chat Completions 响应翻成 Responses 响应对象。
 */
export function translateNonStreaming(
  chat: Record<string, unknown>,
  map: ToolNameMap,
  model: string
): Record<string, unknown> {
  const output: Record<string, unknown>[] = []
  const choices = Array.isArray(chat.choices) ? (chat.choices as Record<string, unknown>[]) : []
  const first = choices[0]
  const message = (first?.message ?? {}) as Record<string, unknown>

  if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
    output.push({
      id: newId('rs'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
      content: []
    })
  }

  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push({
      id: newId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }]
    })
  }

  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : []
  for (const call of toolCalls) {
    const fn = (call.function ?? {}) as Record<string, unknown>
    const chatName = String(fn.name ?? '')
    const entry = map.byChatName.get(chatName)
    const item: Record<string, unknown> = {
      id: newId('fc'),
      type: 'function_call',
      call_id: String(call.id ?? newId('call')),
      name: entry?.name ?? chatName,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
      status: 'completed'
    }
    if (entry?.namespace) item.namespace = entry.namespace
    output.push(item)
  }

  return {
    id: newId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: mapUsage(chat.usage) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  }
}

/**
 * 消费上游 SSE 字节流，逐个事件翻译后交给 Codex。
 */
export async function pipeChatStreamToResponses(
  upstream: ReadableStream<Uint8Array>,
  translator: ChatToResponsesTranslator
): Promise<StreamResult> {
  translator.begin()
  const parser = new SseParser()
  const decoder = new TextDecoder('utf-8')

  for await (const chunk of upstream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true })
    for (const payload of parser.push(text)) {
      translator.handlePayload(payload)
      if (translator.isFinished) return translator.finish()
    }
  }
  const tail = decoder.decode()
  if (tail.length > 0) {
    for (const payload of parser.push(tail)) {
      translator.handlePayload(payload)
    }
  }
  for (const payload of parser.flush()) {
    translator.handlePayload(payload)
  }
  return translator.finish()
}
