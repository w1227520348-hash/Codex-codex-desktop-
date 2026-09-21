/**
 * M3 端到端测试：逐动作审批
 *
 * 链路：Orchestrator（审批模式 app-server）→ 真实 `codex app-server` → 内置桥 → mock DeepSeek
 *
 * 验证三种按钮语义都能真正影响 codex 的行为：
 *   allow_once  → 命令被批准执行，文件被创建
 *   deny        → 命令被拒绝，文件不存在
 *   allow_always→ 会话内批准（acceptForSession），命令执行
 *
 * 运行：node test/appserver-e2e.mjs
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

/* ---------------- 隔离 HOME ---------------- */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-m3-home-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

/* ---------------- mock DeepSeek 上游 ---------------- */
let commandToRun = ''
let round = 0
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
  round += 1
  seenRequests.push(body)

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-m3',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })

  if (round === 1) {
    send(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_m3_1',
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ cmd: commandToRun }) }
          }
        ]
      })
    )
    send(chunk({}, 'tool_calls'))
    send({ id: 'chatcmpl-m3', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })
  } else {
    send(chunk({ role: 'assistant', content: '本轮结束。' }))
    send(chunk({}, 'stop'))
    send({ id: 'chatcmpl-m3', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 150, completion_tokens: 8, total_tokens: 158 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve))
const mockPort = mockUpstream.address().port

/* ---------------- 打包并加载 Orchestrator ---------------- */
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

const appDir = path.join(fakeHome, '.codex-desktop')
fs.mkdirSync(appDir, { recursive: true })
fs.writeFileSync(
  path.join(appDir, 'config.json'),
  JSON.stringify(
    {
      apiKey: 'sk-m3-e2e',
      model: 'deepseek-chat',
      temperature: 0.2,
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      reuseUserCodexConfig: false,
      useNativeResponses: false,
      permissionMode: 'read-only',
      engine: 'app-server',
      theme: 'dark',
      maxOutputTokens: 0,
      recentWorkspaces: []
    },
    null,
    2
  ),
  'utf8'
)

/* ---------------- 带审批交互的事件收集 ---------------- */
const events = []
let autoDecision = 'allow_once'
let approvalRequests = []
let sessionIdForApproval = ''

const orchestrator = new Orchestrator((channel, payload) => {
  if (channel !== 'harness:event') return
  events.push(payload)
  if (payload.event.type === 'approval.request') {
    approvalRequests.push(payload.event.request)
    // 模拟用户在界面上点按钮
    setTimeout(() => {
      const ok = orchestrator.respondApproval(payload.sessionId, payload.event.request.id, autoDecision)
      if (!ok) console.log(`  [warn] respondApproval 返回 false（approvalId=${payload.event.request.id}）`)
    }, 200)
  }
})

await orchestrator.ensureBridge()
console.log(`协议桥：${orchestrator.bridgeBaseUrl}\n`)

/**
 * 等待某一轮结束。
 * app-server 现在是常驻进程（为了保住 thread 上下文），所以一轮结束时不再有 exit 事件，
 * 要看 turn.ended —— 这正是上下文连贯改造带来的生命周期变化。
 */
function waitForTurnEnd(id, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const done = () => events.some((p) => p.sessionId === id && p.event.type === 'turn.ended')
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

async function runScenario({ label, decision, expectFile }) {
  console.log(`──────── 场景：${label}（决定=${decision}）────────`)
  events.length = 0
  approvalRequests = []
  seenRequests.length = 0
  round = 0
  autoDecision = decision

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-m3-ws-'))
  fs.writeFileSync(path.join(workspace, 'README.md'), '# m3 e2e\n')
  const probeFile = path.join(workspace, 'm3-probe.txt')
  commandToRun = `echo approved > "${probeFile}"`

  const started = await orchestrator.startTask({
    sessionId: 'placeholder',
    workspace,
    prompt: '请创建这个文件',
    permissionMode: 'read-only'
  })
  if (!started.ok) {
    record(`[${label}] 任务能启动`, false, started.error)
    return {}
  }
  sessionIdForApproval = started.sessionId
  await waitForTurnEnd(sessionIdForApproval)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const list = events.filter((e) => e.sessionId === sessionIdForApproval).map((e) => e.event)
  const approvals = list.filter((e) => e.type === 'approval.request')
  const resolved = list.filter((e) => e.type === 'approval.resolved')
  const requests = [...seenRequests]
  const fileExists = fs.existsSync(probeFile)

  console.log(`  审批请求数=${approvals.length} 已解决=${resolved.length} 文件存在=${fileExists}`)
  if (approvals.length > 0) {
    console.log(`  审批详情：kind=${approvals[0].request.kind} command=${JSON.stringify(String(approvals[0].request.command ?? '').slice(0, 90))}`)
    console.log(`  理由：${JSON.stringify(String(approvals[0].request.detail ?? '').slice(0, 120))}`)
  }
  const otherEvents = list.filter((e) => !e.type.startsWith('item.') && e.type !== 'approval.request' && e.type !== 'approval.resolved')
  console.log(`  其它事件：${otherEvents.map((e) => e.type).join(', ')}`)

  record(`[${label}] 收到 approval.request`, approvals.length > 0, approvals.length ? `kind=${approvals[0].request.kind}` : '没有收到审批请求')
  record(`[${label}] 审批带上了待执行命令`, Boolean(approvals[0]?.request?.command))
  record(`[${label}] 收到 approval.resolved=${decision}`, resolved.some((e) => e.decision === decision), JSON.stringify(resolved.map((e) => e.decision)))
  record(`[${label}] 文件${expectFile ? '被创建' : '未被创建'}`, fileExists === expectFile, `exists=${fileExists}`)
  record(`[${label}] 本轮正常收尾`, list.some((e) => e.type === 'turn.ended'))
  const turnCompleted = list.find((e) => e.type === 'turn.completed')
  record(
    `[${label}] turn.completed 带上了 token 用量`,
    Boolean(turnCompleted?.usage && (turnCompleted.usage.totalTokens ?? 0) > 0),
    JSON.stringify(turnCompleted?.usage ?? null)
  )

  // 常驻的 app-server 仍然把这个目录当作 cwd，Windows 下会锁住目录，
  // 所以先回收进程再删；删不掉也不影响断言结果（由系统清理临时目录）。
  orchestrator.disposeEngines()
  await new Promise((resolve) => setTimeout(resolve, 400))
  try {
    fs.rmSync(workspace, { recursive: true, force: true })
  } catch {
    /* ignore: 目录仍被占用时留给系统清理 */
  }
  return { list, approvals, resolved, fileExists, requests }
}

/* ---------------- 三个场景 ---------------- */
const allowOnce = await runScenario({ label: '允许一次', decision: 'allow_once', expectFile: true })
console.log('')
const deny = await runScenario({ label: '拒绝', decision: 'deny', expectFile: false })
console.log('')
const allowAlways = await runScenario({ label: '总是允许', decision: 'allow_always', expectFile: true })

/* ---------------- 追加断言 ---------------- */
console.log('\n=== 追加断言 ===')

// 被批准时：第 2 次上游请求里 role=tool 的输出应当体现命令真的执行了
const allowToolMessage = allowOnce.requests?.[1]?.messages?.find((m) => m.role === 'tool')
record(
  '批准后命令真的执行（工具输出回到上游）',
  Boolean(allowToolMessage && /approved|Process exited with code 0|exited with code 0/i.test(String(allowToolMessage.content))),
  allowToolMessage ? JSON.stringify(String(allowToolMessage.content).replace(/\s+/g, ' ').slice(0, 140)) : '未找到 tool 消息'
)

// 被拒绝时：模型应当收到明确的拒绝反馈
const denyToolMessage = deny.requests?.[1]?.messages?.find((m) => m.role === 'tool')
const denyFeedback = String(denyToolMessage?.content ?? '')
record(
  '拒绝后有明确反馈回给模型',
  /declin|denied|reject|not approved|user/i.test(denyFeedback),
  JSON.stringify(denyFeedback.replace(/\s+/g, ' ').slice(0, 160)) || '未找到 tool 消息'
)

// 会话持久化里应保留审批事件
const sessionsDir = path.join(appDir, 'sessions')
const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []
let approvalPersisted = false
for (const file of files) {
  const detail = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'))
  for (const turn of detail.turns ?? []) {
    if ((turn.events ?? []).some((e) => e.type === 'approval.request')) approvalPersisted = true
  }
}
record('审批事件被持久化进会话', approvalPersisted, `会话文件数=${files.length}`)
record(
  '三种按钮语义都跑通（allow_once / deny / allow_always）',
  (allowOnce.resolved?.length ?? 0) > 0 && (deny.resolved?.length ?? 0) > 0 && (allowAlways.resolved?.length ?? 0) > 0,
  `allow_once=${allowOnce.resolved?.length ?? 0} deny=${deny.resolved?.length ?? 0} allow_always=${allowAlways.resolved?.length ?? 0}`
)

/* ---------------- 清理 ---------------- */
await orchestrator.restartBridge().catch(() => undefined)
await new Promise((resolve) => mockUpstream.close(resolve))
try {
  fs.rmSync(fakeHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
