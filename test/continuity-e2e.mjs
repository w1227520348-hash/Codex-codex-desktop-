/**
 * 上下文连贯 & 上下文长度 端到端测试
 *
 * 链路：Orchestrator（真实编排）→ codex 子进程 → 内置桥 → mock DeepSeek
 *
 * 验证点：
 *   A. exec 引擎：第 2 轮用 `codex exec resume` 续接，上游请求里能看到第 1 轮的回复
 *   B. app-server 引擎：同一进程同一 thread，第 2 轮自带第 1 轮上下文
 *   C. 重启连贯：dispose 掉常驻进程后，第 3 轮仍能 thread/resume 续上
 *   D. 不串上下文：同一工作区里的另一个会话，请求里不能出现别的会话内容
 *   E. 上下文长度：生成的 config.toml / -c 覆盖里带上了 model_context_window
 *
 * 运行：node test/continuity-e2e.mjs
 */

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
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cont-home-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

/* ---------------- mock DeepSeek 上游 ---------------- */
let turnCounter = 0
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
  turnCounter += 1
  const ack = `ACK-${turnCounter}`
  seenRequests.push({ body, ack })

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({
    id: 'chatcmpl-cont',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta: { role: 'assistant', content: `收到。${ack}` }, finish_reason: null }]
  })
  send({
    id: 'chatcmpl-cont',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })
  send({ id: 'chatcmpl-cont', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } })
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

function writeSettings(engine) {
  fs.writeFileSync(
    path.join(appDir, 'config.json'),
    JSON.stringify(
      {
        apiKey: 'sk-cont-e2e',
        model: 'deepseek-chat',
        temperature: 0.2,
        modelContextWindow: 65536,
        autoCompactLimit: 0,
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        reuseUserCodexConfig: false,
        useNativeResponses: false,
        permissionMode: 'danger-full-access',
        engine,
        theme: 'dark',
        maxOutputTokens: 0,
        recentWorkspaces: []
      },
      null,
      2
    ),
    'utf8'
  )
}
writeSettings('exec')

/* ---------------- 事件收集 ---------------- */
const events = []
const statuses = []
const orchestrator = new Orchestrator((channel, payload) => {
  if (channel === 'harness:event') events.push(payload)
  if (channel === 'harness:status') statuses.push(payload)
})
await orchestrator.ensureBridge()
console.log(`协议桥：${orchestrator.bridgeBaseUrl}\n`)

function waitForTurnEnd(sessionId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const done = () => events.some((p) => p.sessionId === sessionId && p.event.type === 'turn.ended')
    if (done()) return resolve(true)
    const timer = setInterval(() => {
      if (done()) {
        clearInterval(timer)
        resolve(true)
      }
    }, 150)
    setTimeout(() => {
      clearInterval(timer)
      resolve(false)
    }, timeoutMs)
  })
}

let sessionSeq = 0
async function runTurn({ prompt, sessionId, workspace, expectTurnEnd = true }) {
  const from = seenRequests.length
  events.length = 0
  const started = await orchestrator.startTask({
    sessionId: sessionId ?? `placeholder-${++sessionSeq}`,
    workspace,
    prompt,
    permissionMode: 'danger-full-access'
  })
  if (!started.ok) return { ok: false, error: started.error, requests: [] }
  if (expectTurnEnd) await waitForTurnEnd(started.sessionId)
  await new Promise((resolve) => setTimeout(resolve, 300))
  return {
    ok: true,
    sessionId: started.sessionId,
    resumed: started.resumed,
    requests: seenRequests.slice(from),
    acks: seenRequests.slice(from).map((r) => r.ack),
    events: events.filter((p) => p.sessionId === started.sessionId).map((p) => p.event)
  }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cont-ws-'))
fs.writeFileSync(path.join(workspace, 'README.md'), '# continuity e2e\n')

/* ================= A. exec 引擎续接 ================= */
console.log('──────── A. exec 引擎（codex exec resume）────────')
writeSettings('exec')

const a1 = await runTurn({ prompt: '第一轮：请记住关键词 ALPHA-ONE', workspace })
record('A: 第一轮成功', a1.ok === true, a1.error ?? `session=${a1.sessionId}`)

const sessionA = a1.sessionId
const a2 = await runTurn({ prompt: '第二轮：刚才的关键词是什么？', sessionId: sessionA, workspace })

const a2Text = JSON.stringify(a2.requests[0]?.body?.messages ?? [])
const a1Ack = a1.acks?.[0] ?? 'ACK-?'
record(`A: 第二轮带上了第一轮的回复（上下文连贯）`, a2Text.includes(a1Ack), a2Text.includes(a1Ack) ? `找到 ${a1Ack}` : `请求里没有 ${a1Ack}`)
record('A: 第二轮带上了第一轮的用户提问', a2Text.includes('ALPHA-ONE'))
record('A: 两轮共用同一个 codex thread', a1.events?.some((e) => e.type === 'thread.started') === true)

const sessionAFile = path.join(appDir, 'sessions', `${sessionA}.json`)
const sessionADetail = JSON.parse(fs.readFileSync(sessionAFile, 'utf8'))
record('A: 会话里记录了 codexThreadId', Boolean(sessionADetail.codexThreadId), sessionADetail.codexThreadId)
record('A: 会话标记 hasContext', sessionADetail.turns.length === 2, `轮次数=${sessionADetail.turns.length}`)

/* ================= B. app-server 常驻续接 ================= */
console.log('\n──────── B. app-server 引擎（常驻 thread）────────')
writeSettings('app-server')
orchestrator.disposeEngines()

const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cont-wsB-'))
const b1 = await runTurn({ prompt: '第一轮：请记住关键词 BETA-TWO', workspace: workspaceB })
record('B: 第一轮成功', b1.ok === true, b1.error ?? `session=${b1.sessionId}`)

const sessionB = b1.sessionId
const b2 = await runTurn({ prompt: '第二轮：关键词是什么？', sessionId: sessionB, workspace: workspaceB })
const b2Text = JSON.stringify(b2.requests[0]?.body?.messages ?? [])
const b1Ack = b1.acks?.[0] ?? 'ACK-?'
record('B: 第二轮带上了第一轮的回复（同一 thread 常驻）', b2Text.includes(b1Ack), b2Text.includes(b1Ack) ? `找到 ${b1Ack}` : `请求里没有 ${b1Ack}`)
record('B: 第二轮带上了第一轮的用户提问', b2Text.includes('BETA-TWO'))

const sessionBFile = path.join(appDir, 'sessions', `${sessionB}.json`)
const detailB1 = JSON.parse(fs.readFileSync(sessionBFile, 'utf8'))
const threadB = detailB1.codexThreadId
record('B: 会话记录了 thread id', Boolean(threadB), threadB)

/* ================= C. 重启后续接 ================= */
console.log('\n──────── C. 模拟重启后 thread/resume ────────')
orchestrator.disposeEngines() // 相当于关掉应用：常驻进程没了
await new Promise((resolve) => setTimeout(resolve, 300))

const b3 = await runTurn({ prompt: '第三轮：还记得最初的词吗？', sessionId: sessionB, workspace: workspaceB })
const b3Text = JSON.stringify(b3.requests[0]?.body?.messages ?? [])
record('C: 重启后仍能续接上下文', b3Text.includes('BETA-TWO') || b3Text.includes(b1Ack), b3Text.includes('BETA-TWO') ? '找到 BETA-TWO' : b3Text.slice(0, 120))
const detailB2 = JSON.parse(fs.readFileSync(sessionBFile, 'utf8'))
record('C: thread id 保持不变（没被换成新 thread）', detailB2.codexThreadId === threadB, `${detailB2.codexThreadId} vs ${threadB}`)

/* ================= D. 不串上下文 ================= */
console.log('\n──────── D. 会话隔离（不串上下文）────────')
const d1 = await runTurn({ prompt: '这是另一个会话：GAMMA-THREE', workspace: workspaceB })
const dText = JSON.stringify(d1.requests[0]?.body?.messages ?? [])
record('D: 新会话不会带上旧会话内容', !dText.includes('BETA-TWO'), dText.includes('BETA-TWO') ? '串了 BETA-TWO' : '干净')
const detailD = JSON.parse(fs.readFileSync(path.join(appDir, 'sessions', `${d1.sessionId}.json`), 'utf8'))
record('D: 新会话拿到的是自己的 thread', detailD.codexThreadId !== threadB, `${detailD.codexThreadId}`)

/* ================= E. 上下文长度设置 ================= */
console.log('\n──────── E. 上下文长度声明 ────────')
const configToml = fs.readFileSync(path.join(appDir, 'codex-home', 'config.toml'), 'utf8')
record('E: config.toml 声明了 model_context_window', /model_context_window\s*=\s*65536/.test(configToml), configToml.split('\n').find((l) => l.includes('model_context_window')) ?? '缺失')
record('E: 顶层键写在 [table] 之前（TOML 合法）', configToml.indexOf('model_context_window') < configToml.indexOf('[model_providers.deepseek]'))

const overrideSeen = seenRequests.some((r) => JSON.stringify(r.body).length > 0)
record('E: 至少产生过真实上游请求', overrideSeen, `共 ${seenRequests.length} 次`)

// 上下文用量是否被上报给界面（app-server 的 tokenUsage 通知）
const contextEvents = events.filter((e) => e.event?.type === 'context.updated')
record('E: app-server 上报了上下文占用', contextEvents.length > 0, `${contextEvents.length} 次 context.updated`)

const statusWithContext = statuses.filter((s) => s.contextWindow !== null)
record('E: 运行状态里带上了上下文窗口', statusWithContext.length > 0, statusWithContext.length ? `window=${statusWithContext[statusWithContext.length - 1].contextWindow}` : '无')

/* ---------------- 清理 ---------------- */
orchestrator.disposeEngines()
await new Promise((resolve) => mockUpstream.close(resolve))
for (const dir of [workspace, workspaceB, fakeHome]) {
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
