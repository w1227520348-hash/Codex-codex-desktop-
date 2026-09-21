/**
 * 内置 Responses↔Chat 协议桥。
 *
 * 为什么要它：codex-cli 0.154.0 已移除 `wire_api = "chat"`，只认 Responses API；
 * 而 DeepSeek 的经典接口是 OpenAI Chat Completions。桥让 Codex 以为自己在跟
 * 一个标准 Responses 端点说话，实际转发到 DeepSeek。
 *
 * 只监听 127.0.0.1 随机端口，API Key 不落盘到 codex 配置里。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pipeChatStreamToResponses, ChatToResponsesTranslator, translateNonStreaming } from './stream'
import { buildUpstreamBody, translateRequest } from './translate'

export interface BridgeLogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/**
 * 桥在数据通路上能“看见”沙箱/策略拒绝，但 `codex exec --json` 不会把它作为事件吐出来
 * （实测：只读模式下被拒绝的命令完全不产生 command_execution 条目）。
 * 因此这里主动嗅探工具回传内容，向上层补一条 denied 通知 —— 需求「被拒绝要有明确反馈」靠它落地。
 */
export interface BridgeNotice {
  level: 'info' | 'warn' | 'denied'
  message: string
}

const DENIAL_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /blocked by policy/i, label: '被沙箱策略拒绝' },
  { re: /rejected:\s*/i, label: '被沙箱策略拒绝' },
  { re: /operation not permitted/i, label: '操作系统拒绝该操作' },
  { re: /permission denied/i, label: '权限不足' },
  { re: /not permitted in (read-only|this sandbox)/i, label: '当前沙箱模式不允许该操作' },
  { re: /sandbox.*(denied|blocked|rejected)/i, label: '被沙箱拒绝' },
  // Windows 沙箱经常在操作系统层拒绝（PowerShell 的 UnauthorizedAccessException / out-file 失败）。
  // 注意：PowerShell 的错误换行会把 "denied" 拆成 "denie\r\nd."，所以匹配前必须先折叠空白。
  { re: /access to the path .{0,200}?is denied/i, label: '操作系统拒绝了该写入（沙箱生效）' },
  { re: /\bis denied\b/i, label: '操作系统拒绝了该操作（沙箱生效）' },
  { re: /access is denied/i, label: '操作系统拒绝了该操作（沙箱生效）' },
  { re: /unauthorizedaccess/i, label: '操作系统拒绝了该操作（沙箱生效）' },
  { re: /read-only file system/i, label: '只读文件系统，拒绝写入' }
]

export interface BridgeOptions {
  /** 上游 API Key（DeepSeek） */
  apiKey: string
  /** 上游 OpenAI 兼容根地址，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  model: string
  temperature: number
  maxOutputTokens: number
  /** 注入 fetch，便于单测替换 */
  fetchImpl?: typeof fetch
  /** 请求超时（毫秒），仅作用于非流式与建连阶段 */
  timeoutMs?: number
  /** 检测到权限/沙箱拒绝时回调 */
  onNotice?: (notice: BridgeNotice) => void
}

export interface BridgeHandle {
  port: number
  /** 提供给 codex 的 base_url（形如 http://127.0.0.1:PORT/v1） */
  baseUrl: string
  getLogs(): BridgeLogEntry[]
  close(): Promise<void>
}

const MAX_LOGS = 300

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const logs: BridgeLogEntry[] = []
  const doFetch = options.fetchImpl ?? fetch

  const log = (level: BridgeLogEntry['level'], message: string): void => {
    logs.push({ at: Date.now(), level, message })
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
    const prefix = level === 'error' ? '[bridge:error]' : level === 'warn' ? '[bridge:warn]' : '[bridge]'
    // 桥的诊断信息走主进程控制台，方便排查；UI 侧通过 getLogs() 读取
    console.log(`${prefix} ${message}`)
  }

  const upstreamUrl = (): string => {
    const base = options.baseUrl.replace(/\/+$/, '')
    return `${base}/chat/completions`
  }

  /** 已上报过的工具调用 id，避免同一次拒绝被重复通知 */
  const reportedToolOutputs = new Set<string>()

  const extractDenial = (body: Record<string, unknown>): BridgeNotice | null => {
    const input = Array.isArray(body.input) ? body.input : []
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const type = String(item.type ?? '')
      if (type !== 'function_call_output' && type !== 'custom_tool_call_output') continue
      const callId = String(item.call_id ?? '')
      const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      if (!callId) continue
      // 去重键包含输出内容：同一个 call_id 在不同会话里复用时不会互相吃掉通知
      const dedupeKey = `${callId}::${text.length}::${text.slice(0, 96)}`
      if (reportedToolOutputs.has(dedupeKey)) continue
      reportedToolOutputs.add(dedupeKey)

      // 折叠空白后再匹配：PowerShell 的错误信息会在单词中间换行（"denie\r\nd."）
      const compact = text.replace(/\s+/g, ' ').trim()
      const hit = DENIAL_PATTERNS.find((p) => p.re.test(compact))
      if (!hit) continue

      // 从拒绝文本里挑出最有信息量的一小段作为反馈
      const snippet = compact.length > 320 ? `${compact.slice(0, 320)}…` : compact
      return { level: 'denied', message: `${hit.label}：${snippet}` }
    }
    return null
  }

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]

    if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          mode: 'responses-to-chat-bridge',
          model: options.model,
          upstream: options.baseUrl,
          hasApiKey: options.apiKey.length > 0
        })
      )
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'method not allowed' } }))
      return
    }

    if (path !== '/v1/responses' && path !== '/responses') {
      log('warn', `收到未预期的路径 ${req.method} ${path}（已返回 404）`)
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `unknown path ${path}` } }))
      return
    }

    const rawBody = await readBody(req)
    const body = safeJsonParse(rawBody)
    if (!body) {
      log('error', '请求体不是合法 JSON')
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid JSON request body' } }))
      return
    }

    if (options.apiKey.length === 0) {
      log('error', '未配置 DeepSeek API Key，拒绝转发')
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: '本地桥未配置 DeepSeek API Key，请在「设置」里填写后重试。', type: 'invalid_request_error' }
        })
      )
      return
    }

    const wantsStream = body.stream !== false
    let translation
    try {
      translation = translateRequest(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `请求翻译失败：${message}`)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `请求翻译失败：${message}` } }))
      return
    }

    if (translation.ignoredInputTypes.length > 0) {
      log('info', `忽略了输入条目类型：${[...new Set(translation.ignoredInputTypes)].join(', ')}`)
    }
    if (translation.map.dropped.length > 0) {
      log('info', `未声明给 DeepSeek 的工具类型：${[...new Set(translation.map.dropped)].join(', ')}`)
    }

    // 沙箱/策略拒绝不会出现在 codex 的事件流里，由桥主动补报
    const denial = extractDenial(body)
    if (denial) {
      log('warn', denial.message)
      options.onNotice?.(denial)
    }

    const upstreamBody = buildUpstreamBody(translation, {
      model: options.model,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      stream: wantsStream,
      toolChoice: body.tool_choice
    })

    const messageCount = translation.messages.length
    const toolCount = translation.tools.length
    log(
      'info',
      `转发 → ${upstreamUrl()}  model=${options.model} messages=${messageCount} tools=${toolCount} stream=${wantsStream}`
    )

    let upstream: Response
    try {
      upstream = await doFetch(upstreamUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
          accept: wantsStream ? 'text/event-stream' : 'application/json'
        },
        body: JSON.stringify(upstreamBody)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `连接上游失败：${message}`)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `无法连接 DeepSeek（${options.baseUrl}）：${message}` } }))
      return
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      const detail = safeJsonParse(text)
      const upstreamMessage =
        (detail?.error as Record<string, unknown> | undefined)?.message ?? (text.slice(0, 500) || upstream.statusText)
      log('error', `上游返回 ${upstream.status}：${String(upstreamMessage)}`)
      res.writeHead(upstream.status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: `DeepSeek 返回 ${upstream.status}：${String(upstreamMessage)}`,
            type: 'upstream_error',
            code: String(upstream.status)
          }
        })
      )
      return
    }

    // ---- 非流式回退 ----
    if (!wantsStream) {
      const text = await upstream.text()
      const chat = safeJsonParse(text)
      if (!chat) {
        log('error', '上游非流式响应不是合法 JSON')
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '上游返回了无法解析的响应' } }))
        return
      }
      const responsesBody = translateNonStreaming(chat, translation.map, options.model)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(responsesBody))
      return
    }

    // ---- 流式：SSE 翻译 ----
    if (!upstream.body) {
      log('error', '上游流式响应没有 body')
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '上游流式响应为空' } }))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })

    const translator = new ChatToResponsesTranslator(
      (eventType, payload) => {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`)
      },
      translation.map,
      options.model
    )

    try {
      const result = await pipeChatStreamToResponses(upstream.body, translator)
      if (result.failed) log('error', '上游流内返回错误，已下发 response.failed')
      else log('info', `完成：output items=${result.output.length}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `流式转发中断：${message}`)
      translator.fail(`本地桥读取上游流失败：${message}`)
    } finally {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('无法获取桥的监听端口')
  }

  log('info', `协议桥已启动：http://127.0.0.1:${address.port}/v1 → ${options.baseUrl}`)

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    getLogs: () => [...logs],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 兜底：等待 keep-alive 连接自然关闭
        setTimeout(resolve, 500)
      })
  }
}
