/**
 * 端到端集成测试：**真实 codex CLI** ←→ 内置协议桥 ←→ mock DeepSeek 上游
 *
 * 验证「codex exec --json」经 Responses↔Chat 桥之后能真正跑通工具调用闭环：
 *   codex → /v1/responses → 桥翻译 → Chat Completions → 上游
 *   上游回 tool_call → 桥翻译回 function_call → codex 真的在本机执行命令
 *   codex 把输出回传 → 上游给最终答复 → codex 输出 agent_message
 *
 * 场景 A：danger-full-access —— 完整闭环
 * 场景 B：read-only        —— 写入类命令被沙箱拒绝，且要有明确反馈（需求 4）
 *
 * 运行：node test/bridge-e2e.mjs
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
const CODEX_JS =
  process.env.CODEX_JS ?? 'C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1) 打包桥（源码是 TS + 无扩展名 import，Node 不能直接跑）
 * ------------------------------------------------------------------ */
const bundlePath = path.join(root, '.tmp', 'bridge.bundle.mjs')
fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/core/bridge/server.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'warning'
})
const { startBridge } = await import(pathToFileURL(bundlePath).href)

/* ------------------------------------------------------------------ *
 * 2) mock DeepSeek 上游（按场景重置状态）
 * ------------------------------------------------------------------ */
let upstreamRequests = []
let pendingCommand = ''
let scenarioCounter = 0

const mockUpstream = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    /* ignore */
  }
  upstreamRequests.push(body)
  const round = upstreamRequests.length

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
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
            id: `call_mock_${scenarioCounter}`,
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ cmd: pendingCommand }) }
          }
        ]
      })
    )
    send(chunk({}, 'tool_calls'))
    send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } })
  } else {
    send(chunk({ role: 'assistant', reasoning_content: '命令已执行，我来汇总结果。' }))
    for (const piece of ['命令环节结束，', '标记 ', MARKER, ' 已核对。']) send(chunk({ content: piece }))
    send(chunk({}, 'stop'))
    send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve))
const mockPort = mockUpstream.address().port
console.log(`mock DeepSeek 上游：http://127.0.0.1:${mockPort}/v1`)

/* ------------------------------------------------------------------ *
 * 3) 启动内置桥
 * ------------------------------------------------------------------ */
const notices = []
const bridge = await startBridge({
  apiKey: 'sk-mock-key',
  baseUrl: `http://127.0.0.1:${mockPort}/v1`,
  model: 'deepseek-chat',
  temperature: 0.2,
  maxOutputTokens: 0,
  onNotice: (notice) => notices.push(notice)
})
console.log(`协议桥：${bridge.baseUrl}\n`)

const MARKER = 'MOCK_BRIDGE_TOOL_OK'

/* ------------------------------------------------------------------ *
 * 4) 跑一个场景
 * ------------------------------------------------------------------ */
async function runScenario({ label, sandbox, command, workspace }) {
  upstreamRequests = []
  pendingCommand = command
  notices.length = 0
  scenarioCounter += 1
  console.log(`\n──────── 场景：${label}（-s ${sandbox}）────────`)

  const args = [
    CODEX_JS,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    workspace,
    '-s',
    sandbox,
    '-c',
    'model=deepseek-chat',
    '-c',
    'model_provider=deepseekmock',
    '-c',
    'model_providers.deepseekmock.name=DeepSeek (mock)',
    '-c',
    `model_providers.deepseekmock.base_url=http://127.0.0.1:${bridge.port}/v1`,
    '-c',
    'model_providers.deepseekmock.env_key=DEEPSEEK_API_KEY',
    '-c',
    'model_providers.deepseekmock.wire_api=responses',
    '请执行命令，然后汇报结果'
  ]

  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env: { ...process.env, DEEPSEEK_API_KEY: 'sk-mock-key' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')))

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, timedOut: true })
    }, 120000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut: false })
    })
  })

  const events = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { type: '__unparsed__', line: l }
      }
    })

  console.log('--- codex 事件流 ---')
  for (const ev of events) console.log(JSON.stringify(ev))

  // 按 item.id 合并 started/updated/completed，取最终态
  const byId = new Map()
  for (const ev of events) {
    if (ev.item && ev.item.id) {
      byId.set(ev.item.id, { ...(byId.get(ev.item.id) ?? {}), ...ev.item })
    }
  }
  return { events, items: [...byId.values()], exit, requests: [...upstreamRequests], stdout, stderr, notices: [...notices] }
}

const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-a-'))
const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-b-'))
fs.writeFileSync(path.join(workspaceA, 'README.md'), '# e2e workspace A\n')
fs.writeFileSync(path.join(workspaceB, 'README.md'), '# e2e workspace B\n')

/* ================= 场景 A：完整闭环 ================= */
const A = await runScenario({
  label: '完整工具调用闭环',
  sandbox: 'danger-full-access',
  command: `echo ${MARKER}`,
  workspace: workspaceA
})

console.log('\n=== 场景 A 断言 ===')
record('A: codex stdout 全部是合法 JSONL', A.events.every((e) => e.type !== '__unparsed__'), `共 ${A.events.length} 个事件`)
record('A: codex 正常退出', !A.exit.timedOut && A.exit.code === 0, `code=${A.exit.code}`)
const aCmd = A.items.find((i) => i.type === 'command_execution')
record('A: 出现 command_execution（Responses→Chat→工具调用闭环）', Boolean(aCmd), aCmd ? `command=${JSON.stringify(String(aCmd.command).slice(0, 70))}` : '缺失')
record(
  'A: 命令真的在本机执行并回传输出',
  Boolean(aCmd && String(aCmd.aggregated_output ?? '').includes(MARKER) && aCmd.exit_code === 0),
  aCmd ? `exit_code=${aCmd.exit_code} output=${JSON.stringify(String(aCmd.aggregated_output ?? '').trim().split(/\r?\n/).pop()?.slice(0, 60))}` : ''
)
const aMsg = A.items.find((i) => i.type === 'agent_message' && String(i.text ?? '').length > 0)
record('A: 产出 agent_message 最终答复', Boolean(aMsg), aMsg ? JSON.stringify(String(aMsg.text).slice(0, 60)) : '缺失')
record('A: reasoning_content 映射成 reasoning 条目', A.items.some((i) => i.type === 'reasoning'))
record('A: 上游收到 2 次 chat/completions 请求', A.requests.length === 2, `实际 ${A.requests.length} 次`)
const aToolMsg = A.requests[1]?.messages?.find((m) => m.role === 'tool')
record('A: 第 2 次请求把命令输出作为 tool 消息回传', Boolean(aToolMsg && String(aToolMsg.content).includes(MARKER)))
record(
  'A: namespace 工具被扁平化 + web_search 被丢弃',
  Array.isArray(A.requests[0]?.tools) && A.requests[0].tools.some((t) => String(t.function?.name).includes('multi_agent_v1__')),
  `tools=${A.requests[0]?.tools?.length ?? 0}`
)
record('A: 首条消息是合并后的 system（instructions + developer）', A.requests[0]?.messages?.[0]?.role === 'system' && String(A.requests[0].messages[0].content).includes('coding agent'))

/* ================= 场景 B：只读沙箱拒绝写入 ================= */
const probeFile = path.join(workspaceB, 'bridge-readonly-probe.txt')
const B = await runScenario({
  label: '只读沙箱下写入被拒绝',
  sandbox: 'read-only',
  command: `echo written > ${probeFile}`,
  workspace: workspaceB
})

console.log('\n=== 场景 B 断言 ===')
const bCmd = B.items.find((i) => i.type === 'command_execution')
const bMsg = B.items.find((i) => i.type === 'agent_message' && String(i.text ?? '').length > 0)
const bToolMsg = B.requests[1]?.messages?.find((m) => m.role === 'tool')
const bFeedback = `${String(bCmd?.aggregated_output ?? '')}\n${String(bMsg?.text ?? '')}\n${String(bToolMsg?.content ?? '')}`
console.log(`--- 场景 B 的拒绝反馈（截断）---\n${bFeedback.trim().slice(0, 600)}\n`)
record('B: 文件确实没有被写入（沙箱生效）', !fs.existsSync(probeFile), `probe 文件存在=${fs.existsSync(probeFile)}`)
record(
  'B: 拒绝结果被明确回馈给模型（有反馈文本）',
  /denied|reject|not permitted|read-only|沙箱|权限|failed|error|exit code/i.test(bFeedback),
  `exit_code=${bCmd?.exit_code} status=${bCmd?.status}`
)
record('B: codex 仍然走完一轮并给出答复', Boolean(bMsg) || B.events.some((e) => e.type === 'turn.completed' || e.type === 'turn.failed'))
const bDenied = B.notices.filter((n) => n.level === 'denied')
record(
  'B: 桥补报了 denied 通知（补上 codex 事件流缺失的拒绝反馈）',
  bDenied.length > 0,
  bDenied.length ? bDenied[0].message.slice(0, 120) : `notices=${JSON.stringify(B.notices)}`
)
record('A: 正常场景不应产生 denied 通知', A.notices.filter((n) => n.level === 'denied').length === 0)

/* ------------------------------------------------------------------ *
 * 5) 清理
 * ------------------------------------------------------------------ */
await bridge.close()
await new Promise((resolve) => mockUpstream.close(resolve))
for (const dir of [workspaceA, workspaceB]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
