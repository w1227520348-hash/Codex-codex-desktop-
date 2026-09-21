/**
 * 审批模式的**界面级**验证：真的点「允许一次 / 拒绝」，看 harness 的行为是否随之改变。
 *
 * 与 test/appserver-e2e.mjs 的区别：那个测的是引擎与编排层；
 * 这个测的是**产品级路径** —— approval.request → 审批卡片 → 点按钮 →
 * window.api.respondApproval → JSON-RPC 回写 codex → 命令真的执行/被拒。
 *
 * 用 mock 上游（本机无真实 Key）：让模型请求执行一条写文件的命令，
 * 配合只读沙箱 → codex 必须征询审批 → 我们点按钮。
 *
 * 运行：node scripts/verify-approval-ui.mjs
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
const PORT = 9380

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
const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-approval-ui-'))
const workspace = path.join(appHome, 'project')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'README.md'), '# approval demo\n')

/** 本轮要请求执行的命令：默认写一个文件（只读沙箱下必须审批） */
let pendingCommand = ''
let requestCount = 0

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

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-approval',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })

  // 每次「模型被调用」都请求一次工具；codex 在审批有结果后会再调一次模型收尾。
  // 注意：必须只看**本轮**（最后一条 user 之后）有没有工具结果 —— 如果扫描整段
  // 历史，第二轮的首次调用会看到第一轮的工具结果，于是直接回文本、不请求命令，
  // 审批卡片自然就不会出现（这是本脚本早先的一个真实误判）。
  const messages = Array.isArray(body.messages) ? body.messages : []
  let lastUser = -1
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === 'user') lastUser = i
  const hasToolResult = messages.slice(lastUser + 1).some((m) => m.role === 'tool')

  if (!hasToolResult) {
    send(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_appr_${requestCount}`,
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ cmd: pendingCommand }) }
          }
        ]
      })
    )
    send(chunk({}, 'tool_calls'))
    send({ id: 'chatcmpl-approval', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 } })
  } else {
    send(chunk({ role: 'assistant', content: '命令环节结束。' }))
    send(chunk({}, 'stop'))
    send({ id: 'chatcmpl-approval', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

fs.writeFileSync(
  path.join(appHome, 'config.json'),
  JSON.stringify({
    apiKey: 'sk-approval-ui',
    model: 'deepseek-chat',
    temperature: 0.2,
    modelContextWindow: 65536,
    autoCompactLimit: 0,
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    reuseUserCodexConfig: false,
    useNativeResponses: false,
    // 只读沙箱 + 审批模式：写操作必须走审批卡片
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

/**
 * 点击按钮。可用 scope 限定范围 —— 聊天气泡里会**保留**已决的审批卡片，
 * 所以点「允许一次」必须限定在仍待决的那张卡片里，否则会点到历史卡片上。
 */
async function clickByText(text, scope = '') {
  const scopeExpr = scope === '' ? 'document' : `document.querySelector(${JSON.stringify(scope)})`
  const hit = await evaluate(
    `(() => { const root = ${scopeExpr}; if (!root) return false
      const b = [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim().includes(${JSON.stringify(text)}) && !x.disabled)
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

/**
 * 当前仍在等待决定的审批卡片。
 * 只认 `.approval-pending`（卡片根节点自带该 class）——
 * 不能靠 body 里有没有「请求执行命令」字样：已决卡片会留在对话记录里，
 * 那样第二次之后就永远为真，等于没测。
 */
const approvalScope = '.approval-pending .approval-actions'

async function pendingApproval() {
  return JSON.parse(
    await evaluate(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.approval-pending')]
      const card = cards[0]
      return {
        count: cards.length,
        buttons: card ? [...card.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim()) : [],
        title: card ? ((card.querySelector('.approval-title') || {}).textContent || '') : '',
        command: card ? ((card.querySelector('.approval-command') || {}).textContent || '') : ''
      }
    })())`)
  )
}

/** 等一张新的待决审批卡片出现 */
async function waitApproval(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await pendingApproval()
    if (state.count > 0) return state
    await sleep(400)
  }
  return null
}

console.log(`工作区：${workspace}\n`)
await clickByText('新建任务')

/* ================= 场景 1：允许一次 → 命令应被执行 ================= */
console.log('──────── 场景 1：点「允许一次」────────')
const probe1 = path.join(workspace, 'allowed.txt')
pendingCommand = `echo approved > "${probe1}"`
const roundsBefore = requestCount

await typePrompt('请创建这个文件')
const card1 = await waitApproval()
record('出现审批卡片', Boolean(card1), card1 ? `按钮：${JSON.stringify(card1.buttons)}` : '未出现')
record(
  '提供三个决定按钮（允许一次 / 总是允许 / 拒绝）',
  Boolean(card1 && card1.buttons.some((b) => b.includes('允许一次')) && card1.buttons.some((b) => b.includes('总是允许')) && card1.buttons.some((b) => b.includes('拒绝'))),
  card1 ? JSON.stringify(card1.buttons) : ''
)

await clickByText('允许一次', approvalScope)
await waitIdle()
await sleep(500)
record('批准后命令真的执行了（文件被创建）', fs.existsSync(probe1), `exists=${fs.existsSync(probe1)}`)
record('批准后模型被再次调用（工具结果回传上游）', requestCount > roundsBefore, `请求数 ${roundsBefore} → ${requestCount}`)
record('批准后卡片转为已决状态（不再有等待中的卡片）', (await pendingApproval()).count === 0, '')
record('界面无报错', !(await bodyText()).includes('握手失败'))

/* ================= 场景 2：拒绝 → 命令不应执行 ================= */
console.log('\n──────── 场景 2：点「拒绝」────────')
const probe2 = path.join(workspace, 'denied.txt')
pendingCommand = `echo rejected > "${probe2}"`

await typePrompt('再创建另一个文件')
const card2 = await waitApproval()
record('第二次也出现审批卡片', Boolean(card2), card2 ? JSON.stringify(card2.buttons) : '未出现')

const beforeDeny = requestCount
await clickByText('拒绝', approvalScope)
await waitIdle()
await sleep(500)
record('拒绝后命令没有执行（文件不存在）', !fs.existsSync(probe2), `exists=${fs.existsSync(probe2)}`)
record('拒绝结果也回传给了模型（上游收到第二次请求）', requestCount > beforeDeny, `请求数 ${beforeDeny} → ${requestCount}`)
record('拒绝后不再有等待中的审批卡片', (await pendingApproval()).count === 0, '')

/* ================= 场景 3：总是允许 → 同一条命令后续不再询问 ================= */
console.log('\n──────── 场景 3：点「总是允许」，再看同一条命令是否还弹卡片 ────────')
const probe3 = path.join(workspace, 'always-1.txt')
// 注意：codex 的 acceptForSession 是按**这条命令（或其策略前缀）**记的，不是「本会话所有命令一律放行」。
// 所以这里第二次必须发**完全相同**的命令，才是对「总是允许」的正确检验；
// 发一条不同的命令去测，会把「按命令记住」误判成「根本没生效」。
const repeatCommand = `echo always > "${probe3}"`
pendingCommand = repeatCommand

await typePrompt('创建第三个文件')
const card3 = await waitApproval()
record('第三次仍会先询问（总是允许只对「之后」生效）', Boolean(card3), card3 ? JSON.stringify(card3.buttons) : '未出现')

await clickByText('总是允许', approvalScope)
await waitIdle()
await sleep(500)
record('点「总是允许」后命令被执行', fs.existsSync(probe3), `exists=${fs.existsSync(probe3)}`)

// 等一个足够区分的时间戳，再用**同一条命令**问一次
await sleep(1200)
const mtimeBefore = fs.existsSync(probe3) ? fs.statSync(probe3).mtimeMs : 0
pendingCommand = repeatCommand
await typePrompt('再执行一次同样的命令')

let cardAppeared = false
let rerun = false
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const mtime = fs.existsSync(probe3) ? fs.statSync(probe3).mtimeMs : 0
  if (mtime > mtimeBefore) {
    rerun = true
    break
  }
  if ((await pendingApproval()).count > 0) {
    cardAppeared = true
    break
  }
  await sleep(500)
}
// 万一还是弹了卡片，点掉它，别让应用卡在等待状态
if (cardAppeared) {
  await clickByText('允许一次', approvalScope)
}
await waitIdle()
await sleep(800)
rerun = rerun || (fs.existsSync(probe3) && fs.statSync(probe3).mtimeMs > mtimeBefore)

record('「总是允许」对同一条命令生效：后续不再弹审批卡片', !cardAppeared, cardAppeared ? '同样的命令又问了一次' : '未再询问')
record('「总是允许」之后的同一条命令被自动执行', rerun, `重新执行=${rerun}`)

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
  console.log('\n--- 主进程输出（尾部）---')
  console.log(mainOut.split(/\r?\n/).filter((l) => l.trim()).slice(-15).join('\n'))
}
process.exit(failed.length === 0 ? 0 : 1)
