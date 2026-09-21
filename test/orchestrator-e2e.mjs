/**
 * 应用主流程端到端测试：Orchestrator（主进程真实编排逻辑）→ 内置桥 → 真实 codex CLI → mock DeepSeek
 *
 * 与 bridge-e2e.mjs 的区别：这里跑的是**应用自己的编排层**，会真实经过
 *   配置生成（~/.codex-desktop/codex-home/config.toml）
 *   → execEngine（spawn + JSONL 解析 + 状态机）
 *   → 会话持久化（sessions/<id>.json）
 *   → 取消任务（taskkill 整棵进程树）
 *
 * 运行：node test/orchestrator-e2e.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1) 把应用配置目录重定向到临时 HOME（避免污染真实 ~/.codex-desktop）
 * ------------------------------------------------------------------ */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-home-'))
// 先记下真实 HOME，用于事后确认没有动过用户自己的 ~/.codex/config.toml
const realHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const realUserConfigPath = realHome ? path.join(realHome, '.codex', 'config.toml') : ''
const realUserConfigBefore = realUserConfigPath && fs.existsSync(realUserConfigPath) ? fs.readFileSync(realUserConfigPath, 'utf8') : null
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

/* ------------------------------------------------------------------ *
 * 2) mock DeepSeek 上游
 * ------------------------------------------------------------------ */
const MARKER = 'ORCHESTRATOR_E2E_OK'
let mode = 'tool'
let requestCount = 0
let pendingCommand = ''
const seenRequests = []

const mockUpstream = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    /* ignore */
  }
  requestCount += 1
  seenRequests.push(body)

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-orch',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })

  // 取消场景：故意拖住首个响应，给测试留出取消窗口
  if (mode === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 30000))
    res.end()
    return
  }

  if (requestCount === 1) {
    send(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_orch_1',
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ cmd: pendingCommand }) }
          }
        ]
      })
    )
    send(chunk({}, 'tool_calls'))
    send({ id: 'chatcmpl-orch', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 111, completion_tokens: 9, total_tokens: 120 } })
  } else {
    send(chunk({ role: 'assistant', reasoning_content: '已拿到命令输出。' }))
    for (const piece of ['执行完毕，', '检测到 ', MARKER, '。']) send(chunk({ content: piece }))
    send(chunk({}, 'stop'))
    send({ id: 'chatcmpl-orch', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 222, completion_tokens: 12, total_tokens: 234 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve))
const mockPort = mockUpstream.address().port

/* ------------------------------------------------------------------ *
 * 3) 打包并加载 Orchestrator（含它引用的所有核心模块）
 * ------------------------------------------------------------------ */
const bundlePath = path.join(root, '.tmp', 'orchestrator.bundle.mjs')
fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/main/orchestrator.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'warning'
})

const { Orchestrator } = await import(pathToFileURL(bundlePath).href)

// 通过 Orchestrator 暴露的路径间接验证配置；设置直接写入 config.json
const appDir = path.join(fakeHome, '.codex-desktop')
fs.mkdirSync(appDir, { recursive: true })
fs.writeFileSync(
  path.join(appDir, 'config.json'),
  JSON.stringify(
    {
      apiKey: 'sk-orchestrator-e2e',
      model: 'deepseek-chat',
      temperature: 0.2,
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      reuseUserCodexConfig: false,
      useNativeResponses: false,
      permissionMode: 'danger-full-access',
      // 本用例专门覆盖 exec 引擎；审批模式（app-server）由 test/appserver-e2e.mjs 覆盖
      engine: 'exec',
      theme: 'dark',
      maxOutputTokens: 0,
      recentWorkspaces: []
    },
    null,
    2
  ),
  'utf8'
)

const events = []
const statuses = []
const orchestrator = new Orchestrator((channel, payload) => {
  if (channel === 'harness:event') events.push(payload)
  if (channel === 'harness:status') statuses.push(payload)
})

await orchestrator.ensureBridge()
console.log(`协议桥：${orchestrator.bridgeBaseUrl}`)
console.log(`配置目录：${appDir}\n`)

/* ------------------------------------------------------------------ *
 * 4) 场景一：完整任务
 * ------------------------------------------------------------------ */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orch-ws-'))
fs.writeFileSync(path.join(workspace, 'README.md'), '# orchestrator e2e\n')
pendingCommand = `echo ${MARKER}`
mode = 'tool'
requestCount = 0

console.log('──────── 场景一：完整任务（startTask → 真实 codex → 事件 → 持久化）────────')
const started = await orchestrator.startTask({
  sessionId: 'placeholder-session-id',
  workspace,
  prompt: '请执行 echo 命令并汇报结果',
  permissionMode: 'danger-full-access'
})
record('startTask 返回成功', started.ok === true, started.error ?? `sessionId=${started.sessionId}`)

const sessionId = started.sessionId ?? ''

/** 等待某个会话的 exit 事件（比轮询 running 标志可靠） */
function waitForExit(id, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const done = () => events.some((p) => p.sessionId === id && p.event.type === 'exit')
    if (done()) return resolve()
    const timer = setInterval(() => {
      if (done()) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, timeoutMs)
  })
}

await waitForExit(sessionId)
await new Promise((resolve) => setTimeout(resolve, 400))

const sessionEvents = events.filter((e) => e.sessionId === sessionId).map((e) => e.event)
const itemsById = new Map()
for (const ev of sessionEvents) {
  if ((ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') && ev.item && 'id' in ev.item) {
    itemsById.set(ev.item.id, { ...(itemsById.get(ev.item.id) ?? {}), ...ev.item })
  }
}
const items = [...itemsById.values()]

console.log('--- 归一化后的事件序列 ---')
for (const ev of sessionEvents) console.log(JSON.stringify(ev).slice(0, 260))

const cmd = items.find((i) => i.kind === 'command_execution')
const msg = items.find((i) => i.kind === 'agent_message')
const reasoning = items.find((i) => i.kind === 'reasoning')
const completed = sessionEvents.find((e) => e.type === 'turn.completed')

record('收到 thread.started', sessionEvents.some((e) => e.type === 'thread.started'))
record('归一化出 command_execution 条目', Boolean(cmd), cmd ? `status=${cmd.status} exitCode=${cmd.exitCode}` : '缺失')
record('命令输出里包含标记', Boolean(cmd && String(cmd.output).includes(MARKER)))
record('命令退出码为 0', cmd?.exitCode === 0, `exitCode=${cmd?.exitCode}`)
record('归一化出 agent_message 条目', Boolean(msg), msg ? JSON.stringify(String(msg.text).slice(0, 50)) : '缺失')
record('归一化出 reasoning 条目', Boolean(reasoning))
record('turn.completed 带上了 usage', Boolean(completed?.usage), completed?.usage ? JSON.stringify(completed.usage) : '缺失')
record('Codex 的「Model metadata」提示被降级为 notice 而非 error', sessionEvents.some((e) => e.type === 'notice' && /Model metadata/.test(e.message)))
record('运行状态回到空闲', orchestrator.getStatus().running === false)
record('状态流里出现过 running=true', statuses.some((s) => s.running === true))

// 生成的 config.toml
const configPath = path.join(appDir, 'codex-home', 'config.toml')
const configToml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
record('生成了隔离的 CODEX_HOME/config.toml', configToml.length > 0, configPath)
record('config.toml 指向本地桥且 wire_api=responses', /wire_api = "responses"/.test(configToml) && configToml.includes(orchestrator.bridgeBaseUrl))
record('config.toml 包含工作区信任项（TOML 未被路径破坏）', configToml.includes('trust_level = "trusted"'))
if (realUserConfigBefore !== null) {
  const after = fs.existsSync(realUserConfigPath) ? fs.readFileSync(realUserConfigPath, 'utf8') : ''
  record('用户真实的 ~/.codex/config.toml 未被改动', after === realUserConfigBefore, realUserConfigPath)
} else {
  record('用户真实的 ~/.codex/config.toml 未被改动', true, '用户本机无该文件，跳过比对')
}

// 会话持久化
const sessionFile = path.join(appDir, 'sessions', `${sessionId}.json`)
record('会话已持久化到磁盘', fs.existsSync(sessionFile), sessionFile)
if (fs.existsSync(sessionFile)) {
  const detail = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  record('持久化内容含轮次与事件', Array.isArray(detail.turns) && detail.turns.length === 1 && detail.turns[0].events.length > 0, `turns=${detail.turns?.length} events=${detail.turns?.[0]?.events?.length}`)
  record('持久化了用户提问与标题', detail.turns[0].prompt.length > 0 && detail.title !== '新任务', `title=${detail.title}`)
  record('会话状态标记为 completed', detail.status === 'completed', `status=${detail.status}`)
}

// 上游收到的第 2 次请求应包含工具输出
const secondRequest = seenRequests[1]
const toolMessage = secondRequest?.messages?.find((m) => m.role === 'tool')
record('第 2 次上游请求带回了命令输出', Boolean(toolMessage && String(toolMessage.content).includes(MARKER)))

/* ------------------------------------------------------------------ *
 * 5) 场景二：取消任务
 * ------------------------------------------------------------------ */
console.log('\n──────── 场景二：取消正在运行的任务 ────────')
mode = 'slow'
requestCount = 0
const workspace2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orch-cancel-'))
const started2 = await orchestrator.startTask({
  sessionId: 'placeholder-2',
  workspace: workspace2,
  prompt: '这个任务会被取消',
  permissionMode: 'danger-full-access'
})
record('第二个任务成功启动', started2.ok === true, started2.error ?? '')

await new Promise((resolve) => setTimeout(resolve, 3000))
const runningBeforeCancel = orchestrator.getStatus().running
record('取消前任务处于运行中', runningBeforeCancel === true)

const cancelled = await orchestrator.cancelTask(started2.sessionId ?? '')
record('cancelTask 返回 true', cancelled === true)

await waitForExit(started2.sessionId ?? '', 60000)
await new Promise((resolve) => setTimeout(resolve, 1200))
record('取消后任务停止运行', orchestrator.getStatus().running === false)

const cancelSessionFile = path.join(appDir, 'sessions', `${started2.sessionId}.json`)
await new Promise((resolve) => setTimeout(resolve, 1200))
if (fs.existsSync(cancelSessionFile)) {
  const detail = JSON.parse(fs.readFileSync(cancelSessionFile, 'utf8'))
  record('被取消的会话持久化为 cancelled', detail.status === 'cancelled', `status=${detail.status}`)
} else {
  record('被取消的会话持久化为 cancelled', false, '会话文件不存在')
}

/* ------------------------------------------------------------------ *
 * 6) 清理
 * ------------------------------------------------------------------ */
await orchestrator.restartBridge().catch(() => undefined)
await new Promise((resolve) => mockUpstream.close(resolve))
for (const dir of [workspace, workspace2, fakeHome]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
