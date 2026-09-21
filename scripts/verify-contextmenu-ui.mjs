/**
 * 右键菜单的**界面级**验证。
 *
 * 说明一下这里为什么这么测：
 *   - Electron 的原生菜单（Menu.popup）不是 DOM，CDP 点不到；而且它在 Windows 上
 *     会进入模态消息循环，真去弹菜单会卡住主进程。所以「菜单里有哪些项、哪些置灰」
 *     由 test/context-menu-unit.mjs 用纯函数钉死；
 *   - 本脚本负责验证**我们自己写的那一半**：右键时渲染层有没有正确认出
 *     「光标下是什么」并上报给主进程 —— 这正是原生菜单的输入。
 *   - 剪贴板则做真实的端到端验证：调 window.api.copyText → 用 PowerShell
 *     Get-Clipboard 读系统剪贴板（不引入任何「只为测试存在」的接口）。
 *
 * 运行：node scripts/verify-contextmenu-ui.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const entry = path.join(root, 'out', 'main', 'index.js')
const PORT = 9383

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

/* ---------------- 夹具 ---------------- */
const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ctxmenu-ui-'))
const workspace = path.join(appHome, 'project')
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'README.md'), '# ctx demo\n')
fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export const a = 1\n')

const MSG_MARKER = 'MSG-MARKER-42'
const CODE_MARKER = 'CODE-MARKER-7'
const CLIP_MARKER = 'CLIP-MARKER-XYZ'

let requestCount = 0

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
    id: 'chatcmpl-ctxmenu',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  const text = `这是回答 ${MSG_MARKER}\n\n下面是一段代码：\n\n\`\`\`ts\nconst CODE = '${CODE_MARKER}'\n\`\`\`\n`
  send(chunk({ role: 'assistant', content: text }))
  send(chunk({}, 'stop'))
  send({ id: 'chatcmpl-ctxmenu', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 } })
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

fs.writeFileSync(
  path.join(appHome, 'config.json'),
  JSON.stringify({
    apiKey: 'sk-ctxmenu-ui',
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
 * 在元素上派发一个**合成的**右键 mousedown。
 * 不用 CDP 的真实右键：那会真的弹出原生菜单并进入模态循环，把主进程卡住。
 * 合成事件只走渲染层的采集逻辑，正好是我们想验证的那部分。
 */
async function probeRightClick(selector) {
  const ok = await evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      el.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, buttons: 2,
        clientX: r.x + Math.min(8, r.width / 2), clientY: r.y + Math.min(8, r.height / 2)
      }))
      return true })()`
  )
  if (!ok) return null
  await sleep(350)
  return await evaluate('window.api.getContextTarget().then((t) => JSON.stringify(t))')
}

await clickByText('新建任务')
await sleep(600)

/* ---------------- 先产生一条回答（含代码块） ---------------- */
await typePrompt('给我一段示例代码')
await waitIdle()
await sleep(1000)
const text = await bodyText()
record('已经渲染出模型回答', text.includes(MSG_MARKER))
record('回答里渲染出了代码块', Boolean(await evaluate(`Boolean(document.querySelector('[data-ctx="code"]'))`)))

/* ================= 1. 各位置的右键目标 ================= */
console.log('\n──────── 1. 右键目标采集 ────────')

const msgTarget = JSON.parse((await probeRightClick('.bubble-row-assistant .bubble-body[data-ctx="message"]')) ?? 'null')
record('消息：识别为 message', msgTarget?.kind === 'message', JSON.stringify(msgTarget)?.slice(0, 120))
record('消息：带上了正文（供「复制这条消息」）', Boolean(msgTarget?.text?.includes(MSG_MARKER)), (msgTarget?.text ?? '').slice(0, 60))
record('消息：带上了默认复制文案', msgTarget?.copyLabel === '复制这条消息', msgTarget?.copyLabel)
record('消息：带上了工作目录（供「复制工作目录」）', msgTarget?.path === workspace, msgTarget?.path)

const codeTarget = JSON.parse((await probeRightClick('[data-ctx="code"]')) ?? 'null')
record('代码块：识别为 code', codeTarget?.kind === 'code', codeTarget?.kind)
record('代码块：取到的是原始源码', codeTarget?.text?.includes(CODE_MARKER) === true, (codeTarget?.text ?? '').trim())
record('代码块：文案是「复制代码」', codeTarget?.copyLabel === '复制代码', codeTarget?.copyLabel)

const composerTarget = JSON.parse((await probeRightClick('textarea[data-ctx="composer"]')) ?? 'null')
record('输入框：识别为 composer', composerTarget?.kind === 'composer', composerTarget?.kind)

// 文件树默认收起子目录：先确认这一点，再展开 src 去右键里面的文件
record('文件树默认只展开第一层（子目录内容不渲染）', (await evaluate(`document.querySelectorAll('.ft-file[data-name="app.ts"]').length`)) === 0)
await evaluate(
  `(() => { const el = document.querySelector('.ft-dir[data-name="src"]'); if (el) el.click(); return true })()`
)
await sleep(500)
record('点目录行可以展开', (await evaluate(`document.querySelectorAll('.ft-file[data-name="app.ts"]').length`)) === 1)

const fileTarget = JSON.parse((await probeRightClick('.ft-file[data-name="app.ts"]')) ?? 'null')
record('文件树：识别为 workspaceFile', fileTarget?.kind === 'workspaceFile', fileTarget?.kind)
record('文件树：带上了真实路径', fileTarget?.path === path.join(workspace, 'src', 'app.ts'), fileTarget?.path)
record('文件树：带上了文件名', fileTarget?.name === 'app.ts', fileTarget?.name)

const sessionTarget = JSON.parse((await probeRightClick('.session-item[data-ctx="session"]')) ?? 'null')
record('会话项：识别为 session', sessionTarget?.kind === 'session', sessionTarget?.kind)
record('会话项：带上了工作目录', sessionTarget?.path === workspace, sessionTarget?.path)
record('会话项：带上了会话 id', typeof sessionTarget?.sessionId === 'string' && sessionTarget.sessionId.length > 0, sessionTarget?.sessionId)

const wsTarget = JSON.parse((await probeRightClick('.workspace-current[data-ctx="workspace"]')) ?? 'null')
record('工作目录标签：识别为 workspace', wsTarget?.kind === 'workspace', wsTarget?.kind)
record('工作目录标签：带上了路径', wsTarget?.path === workspace, wsTarget?.path)

/* ================= 2. 附件 chip 的右键目标 ================= */
console.log('\n──────── 2. 附件 chip ────────')
await clickByText('README.md')
await sleep(600)
const attachTarget = JSON.parse((await probeRightClick('.attach-strip .attach-chip')) ?? 'null')
record('附件 chip：识别为 attachment', attachTarget?.kind === 'attachment', attachTarget?.kind)
record('附件 chip：带上了路径', typeof attachTarget?.path === 'string' && attachTarget.path.endsWith('README.md'), attachTarget?.path)
record('附件 chip：带上了附件 id（供「移除附件」）', typeof attachTarget?.attachmentId === 'string' && attachTarget.attachmentId.length > 0, attachTarget?.attachmentId)

/* ================= 3. 剪贴板端到端 ================= */
console.log('\n──────── 3. 剪贴板 ────────')
const readClipboard = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).trim()
  } catch (error) {
    return `READ_FAILED:${error instanceof Error ? error.message : String(error)}`
  }
}

await evaluate(`window.api.copyText(${JSON.stringify(CLIP_MARKER)})`)
await sleep(400)
record('copyText 写入的内容能在系统剪贴板里读到', readClipboard() === CLIP_MARKER, JSON.stringify(readClipboard()).slice(0, 60))

// 菜单里的「复制这条消息」走的就是「把 target.text 写进剪贴板」，
// 这里用采集到的真实 target.text 走一遍，验证到剪贴板这一段是通的。
await evaluate(`window.api.copyText(${JSON.stringify(msgTarget?.text ?? '')})`)
await sleep(400)
const clipMsg = readClipboard()
record('复制消息正文到剪贴板可用', clipMsg.includes(MSG_MARKER), clipMsg.slice(0, 60))
record('复制的是完整正文而不只是开头', clipMsg.includes(CODE_MARKER), clipMsg.length.toString())

/* ================= 4. 真实右键不崩 ================= */
console.log('\n──────── 4. 真实右键（原生菜单路径）────────')
const box = await evaluate(
  `(() => { const el = document.querySelector('.bubble-row-assistant .bubble-body[data-ctx="message"]'); if (!el) return null
    const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + 10), y: Math.round(r.y + 10) }) })()`
)
if (box) {
  const { x, y } = JSON.parse(box)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 })
  await sleep(1200)
  // 渲染进程仍可求值 ⇒ 真实右键没有把应用搞崩
  const alive = await evaluate('1 + 1')
  record('真实右键唤出原生菜单后应用没有崩溃', alive === 2, `渲染进程返回 ${alive}`)
  record('主进程没有报出异常', !mainOut.includes('Unhandled') && !/TypeError|ReferenceError/.test(mainOut), '')
  // 关掉菜单：Esc 交给窗口
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
} else {
  record('真实右键唤出原生菜单后应用没有崩溃', false, '找不到可右键的消息气泡')
}

/* ================= 5. 未上报时不弹菜单 ================= */
console.log('\n──────── 5. 空白处 ────────')
const beforeEmpty = JSON.parse((await evaluate('window.api.getContextTarget().then((t) => JSON.stringify(t))')) ?? 'null')
record('上一次上报的目标仍然可读（诊断接口可用）', beforeEmpty !== null)

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
  console.log(mainOut.split(/\r?\n/).filter((l) => l.trim()).slice(-20).join('\n'))
}
process.exit(failed.length === 0 ? 0 : 1)
