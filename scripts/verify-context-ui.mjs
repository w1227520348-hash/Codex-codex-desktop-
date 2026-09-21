/**
 * 上下文连贯性的**界面级**验证：连问三轮，直接检查真正发往上游的 messages 里
 * 是否带着前几轮的内容。
 *
 * 与 test/continuity-e2e.mjs 的区别：那个在引擎层断言 thread 复用与 resume；
 * 这个走**完整产品链路** —— 输入框 → orchestrator → app-server → bridge →
 * 上游 HTTP 请求体。断言的是「模型真的看得到上一轮」，而不是界面画了几条气泡。
 *
 * mock 上游把「自己看到了几轮、看没看到第一轮暗号」写进回复文本，
 * 再断言这段文本真的被渲染到界面上 —— 于是「界面上看得见」= 「模型确实收到了」。
 *
 * 运行：node scripts/verify-context-ui.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const entry = path.join(root, 'out', 'main', 'index.js')
const PORT = 9381

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

/* ---------------- 沙箱目录 ---------------- */
const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-ui-'))
const workspace = path.join(appHome, 'project')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'README.md'), '# context demo\n')

/** 每轮上游请求的观测记录 */
const observations = []
/** 每轮我们回的答复原文（供后续轮次做「上轮答复有没有进历史」的断言） */
const replies = []
/** 会话分界：第 N 次「新建任务」之后算新会话 */
let requestCount = 0

const MARK_A = 'ALPHA7'

/* ---------------- mock 上游 ---------------- */
const mock = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    /* ignore */
  }
  requestCount += 1

  const messages = Array.isArray(body.messages) ? body.messages : []
  const userMsgs = messages.filter((m) => m.role === 'user')
  const userText = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
  const joined = userMsgs.map(userText).join('\n')

  const round = userMsgs.length
  const seesMarkA = joined.includes(MARK_A)
  const seesPrevReply = replies.length > 0 && messages.some((m) => m.role === 'assistant' && userText(m).includes(replies[replies.length - 1]))

  // 把观测结果写进回复文本：界面上一眼可见 = 模型确实收到了
  const reply = `R${round}|users=${round}|alpha7=${seesMarkA}|prev=${seesPrevReply}`
  replies.push(reply)
  observations.push({ round, seesMarkA, seesPrevReply, userMsgs: joined, reply })

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({
    id: 'chatcmpl-ctx',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta: { role: 'assistant', content: reply } }]
  })
  send({
    id: 'chatcmpl-ctx',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })
  send({ id: 'chatcmpl-ctx', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100 * round, completion_tokens: 8, total_tokens: 100 * round + 8 } })
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

fs.writeFileSync(
  path.join(appHome, 'config.json'),
  JSON.stringify({
    apiKey: 'sk-context-ui',
    model: 'deepseek-chat',
    temperature: 0.2,
    modelContextWindow: 65536,
    autoCompactLimit: 0,
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    reuseUserCodexConfig: false,
    useNativeResponses: false,
    permissionMode: 'read-only',
    engine: 'app-server',
    theme: 'dark',
    maxOutputTokens: 0,
    recentWorkspaces: [workspace],
    appearance: { background: null, wallpaper: null, backgroundOverlay: 0.22, backgroundBlur: 0, slots: {}, showAvatars: true, stylePreset: 'anime' }
  }),
  'utf8'
)

/* ---------------- 启动真实应用 ---------------- */
const child = spawn(electronBin, [entry, workspace, `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env: { ...process.env, CODEX_DESKTOP_HOME: appHome },
  stdio: ['ignore', 'pipe', 'pipe']
})
let mainOut = ''
child.stdout.on('data', (d) => (mainOut += d.toString()))
child.stderr.on('data', (d) => (mainOut += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* wait */
    }
    await sleep(500)
  }
  return null
}

const page = await findTarget()
if (!page) {
  console.error('无法连接渲染进程：')
  console.error(mainOut)
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
await send('Runtime.enable')
await sleep(2800)

const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value
const bodyText = async () => String(await evaluate('document.body.innerText'))

async function clickByText(text) {
  const hit = await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().includes(${JSON.stringify(text)}) && !x.disabled)
      if (!b) return false
      const r = b.getBoundingClientRect(); if (r.width === 0) return false
      window.__ct = [r.x + r.width / 2, r.y + r.height / 2]; return true })()`
  )
  if (!hit) return false
  const [x, y] = JSON.parse(await evaluate('JSON.stringify(window.__ct)'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(400)
  return true
}

async function typePrompt(text) {
  await evaluate(`(() => { const t = document.querySelector('textarea'); if (!t) return false; t.focus(); return true })()`)
  await send('Input.insertText', { text })
  await sleep(200)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  }
}

const isRunning = async () =>
  Boolean(await evaluate(`!!([...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('停止')))`))

async function waitIdle(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isRunning())) return true
    await sleep(400)
  }
  return false
}

/** 发一轮并等它跑完，返回这一轮上游的观测 */
async function ask(text) {
  const before = observations.length
  await typePrompt(text)
  await waitIdle()
  await sleep(700)
  return observations[before] ?? null
}

console.log(`工作区：${workspace}\n`)
await clickByText('新建任务')

/* ================= 会话 A：连问三轮 ================= */
console.log('──────── 会话 A：连问三轮，检查每轮上游真实收到的历史 ────────')

const r1 = await ask(`第一轮：请记住暗号 ${MARK_A}`)
record('第 1 轮：上游收到 1 条 user 消息', r1?.round === 1, r1 ? `users=${r1.round}` : '上游未被调用')
// 基线：第一轮请求里不该有任何 assistant 历史。
// （注意：不能拿「暗号」做基线 —— 暗号本来就是第一轮自己说的，必然为 true。
//   「看不到旧内容」这条基线由会话 B 负责断言。）
record('第 1 轮：此时没有任何历史答复（基线）', r1?.seesPrevReply === false, r1 ? `prev=${r1.seesPrevReply}` : '')

const r2 = await ask('第二轮：刚才的暗号是什么？')
record('第 2 轮：上游收到 2 条 user 消息', r2?.round === 2, r2 ? `users=${r2.round}` : '上游未被调用')
record('第 2 轮：请求里带着第 1 轮的暗号（上下文续接）', r2?.seesMarkA === true, r2 ? `alpha7=${r2.seesMarkA}` : '')
record('第 2 轮：请求里也带着第 1 轮的模型答复', r2?.seesPrevReply === true, r2 ? `prev=${r2.seesPrevReply}` : '')

const r3 = await ask('第三轮：再确认一次。')
record('第 3 轮：上游收到 3 条 user 消息', r3?.round === 3, r3 ? `users=${r3.round}` : '上游未被调用')
record('第 3 轮：第 1 轮的暗号仍未丢失（没有被静默截断）', r3?.seesMarkA === true, r3 ? `alpha7=${r3.seesMarkA}` : '')
record('第 3 轮：带着第 2 轮的答复', r3?.seesPrevReply === true, r3 ? `prev=${r3.seesPrevReply}` : '')

record('每轮只调用一次上游（无重复发送）', requestCount === 3, `请求数=${requestCount}`)

const textA = await bodyText()
record('界面渲染了三轮回复', ['R1|', 'R2|', 'R3|'].every((m) => textA.includes(m)), `含 R1/R2/R3=${['R1|', 'R2|', 'R3|'].map((m) => textA.includes(m)).join('/')}`)
record('界面上能看到「R2|...|alpha7=true」= 模型确实收到第 1 轮', textA.includes('alpha7=true'), '')
record('状态栏显示「已续接上下文」', textA.includes('已续接上下文'), '')
// 徽章文案形如「上下文 624 / 62.3K（1%）」——注意别把「已续接上下文」也算进来
const contextLine = (textA.match(/上下文\s+[\d.]+[KM]?\s*\/\s*[\d.]+[KM]?\s*（\s*\d+%\s*）/) ?? [''])[0]
const statusText = String(await evaluate(`(document.querySelector('.statusbar') || {}).innerText || '(没有 .statusbar)'`))
record(
  '状态栏显示上下文占用 / 窗口',
  contextLine.length > 0,
  contextLine || `未找到「上下文 X / Y（Z%）」徽标；状态栏实际文案=${JSON.stringify(statusText.replace(/\n/g, '⏎'))}`
)
record('界面无「握手失败」', !textA.includes('握手失败'), '')

/* ================= 会话 B：新建任务后不应串味 ================= */
console.log('\n──────── 会话 B：新建任务，检查不串上下文 ────────')
const beforeNew = requestCount
await clickByText('新建任务')
await sleep(600)

const rB = await ask('新会话第一轮，只问一句。')
record('新会话确实发起了新一轮请求', requestCount > beforeNew, `请求数 ${beforeNew} → ${requestCount}`)
record('新会话：上游只收到 1 条 user 消息', rB?.round === 1, rB ? `users=${rB.round}` : '上游未被调用')
record('新会话：看不到旧会话的暗号（会话隔离）', rB?.seesMarkA === false, rB ? `alpha7=${rB.seesMarkA}` : '')

/* ================= 汇总 ================= */
ws.close()
child.kill()
await sleep(600)
await new Promise((r) => mock.close(r))
try {
  fs.rmSync(appHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
  console.log('\n--- 每轮上游观测 ---')
  for (const o of observations) console.log(`  R${o.round}: users=${o.round} alpha7=${o.seesMarkA} prev=${o.seesPrevReply}`)
  console.log('\n--- 主进程输出（尾部）---')
  console.log(mainOut.split(/\r?\n/).filter((l) => l.trim()).slice(-15).join('\n'))
}
process.exit(failed.length === 0 ? 0 : 1)
