/**
 * 「提交文件」的**界面级**验证。
 *
 * 走完整产品链路：隐藏的原生 file input（用 CDP 的 DOM.setFileInputFiles 真实投喂文件）
 * → 渲染层 chips → 主进程拷贝/嗅探/内联 → 拼进提示词 → codex 用工具读取。
 *
 * 两条关键证据：
 *   1. 上游请求体里出现了文件正文（说明小文本文件真的内联进了提示词）；
 *   2. mock 让 codex 用 exec_command 去读附件路径，工具输出里带回了文件内容
 *      （说明工作区之外的文件被拷到应用数据目录后，codex 在只读沙箱下也**读得到**）。
 *
 * 运行：node scripts/verify-attach-ui.mjs
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
const PORT = 9382

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

/* ---------------- 夹具：附件放在工作区**之外**，强制走「拷贝」这条路 ---------------- */
const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-attach-ui-'))
const workspace = path.join(appHome, 'project')
const outside = path.join(appHome, 'outside')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n')

const MARKER = 'ATTACH-MARKER-9F3'
const notesPath = path.join(outside, 'notes.md')
fs.writeFileSync(notesPath, `# 附件笔记\n\n关键结论：${MARKER}\n`, 'utf8')
const binPath = path.join(outside, 'blob.bin')
fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0xfe, 0x41, 0x42]))

const observations = { inlineSeen: null, readSeen: null, attachmentPath: null, toolCommand: null, toolOutput: null, approvals: 0, approvalCommand: null }
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

  const messages = Array.isArray(body.messages) ? body.messages : []
  const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
  const allText = messages.map(textOf).join('\n')

  let lastUser = -1
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === 'user') lastUser = i
  const afterUser = messages.slice(lastUser + 1)
  const hasToolResult = afterUser.some((m) => m.role === 'tool')

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-attach',
    object: 'chat.completion.chunk',
    model: body.model ?? 'deepseek-chat',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

  if (!hasToolResult) {
    // 第一次调用：先看提示词里有没有内联正文，再让 codex 用工具去读附件
    observations.inlineSeen = allText.includes(MARKER)
    const hit = allText.match(/[A-Za-z]:\\[^\s"']*?notes\.md/)
    observations.attachmentPath = hit ? hit[0] : null
    if (hit) {
      // -Encoding UTF8 是必须的：Windows PowerShell 默认按 ANSI 读，
      // UTF-8 文件会整片乱码，连 ASCII 标记都会被多字节序列吃掉。
      const command = `Get-Content -Raw -Encoding UTF8 "${hit[0]}"`
      observations.toolCommand = command
      send(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_attach_${requestCount}`,
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ cmd: command }) }
            }
          ]
        })
      )
      send(chunk({}, 'tool_calls'))
    } else {
      send(chunk({ role: 'assistant', content: '没有在提示词里找到附件路径。' }))
      send(chunk({}, 'stop'))
    }
  } else {
    // 第二次调用：工具结果已经回来了，看它有没有带回文件内容
    const toolText = afterUser
      .filter((m) => m.role === 'tool')
      .map(textOf)
      .join('\n')
    observations.readSeen = toolText.includes(MARKER)
    observations.toolOutput = toolText.slice(0, 1200)
    send(chunk({ role: 'assistant', content: `INLINE=${observations.inlineSeen} READ=${observations.readSeen}` }))
    send(chunk({}, 'stop'))
  }

  send({
    id: 'chatcmpl-attach',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 }
  })
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

fs.writeFileSync(
  path.join(appHome, 'config.json'),
  JSON.stringify({
    apiKey: 'sk-attach-ui',
    model: 'deepseek-chat',
    temperature: 0.2,
    modelContextWindow: 65536,
    autoCompactLimit: 0,
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    reuseUserCodexConfig: false,
    useNativeResponses: false,
    // 只读沙箱：最严格的一档，用来验证「拷到应用数据目录后 codex 仍读得到」
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
await send('DOM.enable')
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

/** 点某个元素（按选择器 + 文本） */
async function clickSelector(selector) {
  const hit = await evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false
      const r = el.getBoundingClientRect(); if (r.width === 0) return false
      window.__ct = [r.x + r.width / 2, r.y + r.height / 2]; return true })()`
  )
  if (!hit) return false
  const [x, y] = JSON.parse(await evaluate('JSON.stringify(window.__ct)'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(500)
  return true
}

/** 用 CDP 往隐藏的原生 file input 里真实投喂文件 */
async function setFilesOnInput(selector, files) {
  const doc = await send('DOM.getDocument', { depth: -1 })
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!found || !found.nodeId) return false
  await send('DOM.setFileInputFiles', { files, nodeId: found.nodeId })
  await sleep(900)
  return true
}

const chips = async () =>
  JSON.parse(
    await evaluate(`JSON.stringify([...document.querySelectorAll('.attach-strip .attach-chip')].map((el) => ({
      name: (el.querySelector('.attach-chip-name') || {}).textContent || '',
      tag: (el.querySelector('.attach-chip-tag') || {}).textContent || '',
      path: el.getAttribute('data-path') || '',
      hasRemove: Boolean(el.querySelector('.attach-chip-remove'))
    })))`)
  )

const isRunning = async () =>
  Boolean(await evaluate(`!!([...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('停止')))`))

async function waitIdle(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 只读沙箱下如果 codex 还是要审批，就点「允许一次」，保证测试不卡住
    const pendingCard = await evaluate(`document.querySelectorAll('.approval-pending').length`)
    if (pendingCard > 0) {
      observations.approvals += 1
      if (observations.approvalCommand === null) {
        observations.approvalCommand = await evaluate(
          `((document.querySelector('.approval-pending .approval-command') || {}).textContent || '').trim()`
        )
      }
      await clickByText('允许一次', '.approval-pending .approval-actions')
      continue
    }
    if (!(await isRunning())) return true
    await sleep(400)
  }
  return false
}

async function typePrompt(text) {
  await evaluate(`(() => { const t = document.querySelector('textarea'); if (!t) return false; t.focus(); return true })()`)
  await send('Input.insertText', { text })
  await sleep(200)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  }
}

console.log(`工作区：${workspace}`)
console.log(`附件（工作区之外）：${outside}\n`)
await clickByText('新建任务')
await sleep(800)

/* ================= 1. 侧栏文件树点击 = 交给 Codex 理解 ================= */
console.log('──────── 1. 侧栏文件树 ────────')
const treeText = await bodyText()
record('侧栏出现「工作区文件」分区', treeText.includes('工作区文件'))
record('文件树列出了工作区文件', treeText.includes('README.md'), '')

const clicked = await evaluate(
  `(() => { const row = [...document.querySelectorAll('.ft-file')].find((el) => (el.getAttribute('data-name') || '') === 'README.md')
    if (!row) return false; row.setAttribute('data-probe', '1'); return true })()`
)
record('找得到文件树里的文件行', clicked)
await clickSelector('.ft-file[data-probe="1"]')
const afterTreeClick = await chips()
record('点击文件行 → 变成输入框里的附件', afterTreeClick.some((c) => c.name === 'README.md'), JSON.stringify(afterTreeClick.map((c) => c.name)))
record('附件 chip 显示「已内联」（小文本文件）', afterTreeClick.find((c) => c.name === 'README.md')?.tag === '已内联', afterTreeClick.map((c) => c.tag).join(','))
record('附件 chip 有移除按钮', afterTreeClick.every((c) => c.hasRemove))
record('工作区内的文件原地引用（路径就是原路径）', afterTreeClick.find((c) => c.name === 'README.md')?.path === path.join(workspace, 'README.md'), afterTreeClick[0]?.path)

/* ================= 2. 原生文件选择器（工作区外的文件） ================= */
console.log('\n──────── 2. 附件按钮 / 文件选择 ────────')
const attached = await setFilesOnInput('input.attach-input', [notesPath])
record('通过原生 file input 投喂文件成功', attached)
const afterNotes = await chips()
record('工作区外的文件也进了附件列表', afterNotes.some((c) => c.name === 'notes.md'), JSON.stringify(afterNotes.map((c) => c.name)))
const notesChip = afterNotes.find((c) => c.name === 'notes.md')
record('工作区外的文件被拷进应用数据目录', Boolean(notesChip) && notesChip.path.startsWith(appHome) && notesChip.path !== notesPath, notesChip?.path)
record('拷贝出来的副本确实存在', Boolean(notesChip) && fs.existsSync(notesChip.path))

await setFilesOnInput('input.attach-input', [binPath])
const afterBin = await chips()
record('二进制附件被标为「工具读取」', afterBin.find((c) => c.name === 'blob.bin')?.tag === '工具读取', JSON.stringify(afterBin.map((c) => `${c.name}:${c.tag}`)))

// 重复添加同一文件不应产生第二份
await setFilesOnInput('input.attach-input', [notesPath])
record('重复添加同一文件会去重', (await chips()).filter((c) => c.name === 'notes.md').length === 1)

// 移除二进制附件
const removed = await evaluate(
  `(() => { const chip = [...document.querySelectorAll('.attach-strip .attach-chip')].find((el) => (el.getAttribute('data-name') || '') === 'blob.bin')
    const btn = chip && chip.querySelector('.attach-chip-remove')
    if (!btn) return false
    const r = btn.getBoundingClientRect(); window.__ct = [r.x + r.width / 2, r.y + r.height / 2]; return true })()`
)
if (removed) {
  const [x, y] = JSON.parse(await evaluate('JSON.stringify(window.__ct)'))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(500)
}
const afterRemove = await chips()
record('点 chip 上的 × 可以移除附件', removed && !afterRemove.some((c) => c.name === 'blob.bin'), JSON.stringify(afterRemove.map((c) => c.name)))

/* ================= 3. 发送：内联 + 工具读取 ================= */
console.log('\n──────── 3. 发送并验证模型/工具都能拿到内容 ────────')
const before = requestCount
await typePrompt('请读一下我提交的文件')
await waitIdle()
await sleep(1200)

record('附件的正文被内联进了提示词（上游请求体里出现文件内容）', observations.inlineSeen === true, `inlineSeen=${observations.inlineSeen}`)
record('提示词里给出了附件路径', observations.attachmentPath !== null, observations.attachmentPath ?? '未找到')
record('模型确实用工具去读了附件', observations.toolCommand !== null, observations.toolCommand ?? '未发起')
record('codex 在只读沙箱下真的读到了附件内容', observations.readSeen === true, `readSeen=${observations.readSeen}`)
// 附件副本放在工作区之外，只读模式下 codex 会因此弹一次审批 —— 这是预期行为，
// 应用会正常弹出审批卡片（本测试用的就是「允许一次」）。
record('读取工作区外的附件最多触发一次审批（审批卡片正常工作）', observations.approvals <= 1, `approvals=${observations.approvals}`)
record('至少发生了一次上游调用', requestCount > before, `${before} → ${requestCount}`)

const finalText = await bodyText()
record('界面上能看到 INLINE=true READ=true', finalText.includes('INLINE=true') && finalText.includes('READ=true'), finalText.match(/INLINE=\w+ READ=\w+/)?.[0] ?? '未找到')

/* ================= 4. 展示与提示词分离 ================= */
console.log('\n──────── 4. 界面展示的是用户原话 ────────')
record('用户气泡显示原话', finalText.includes('请读一下我提交的文件'))
record('界面不会把拼好的大段附件正文显示出来', !finalText.includes('【文件正文】'))
record('本轮回看里带有附件 chip', (await evaluate(`document.querySelectorAll('.turn-attachments .attach-chip').length`)) >= 1)
record('附件提示以 notice 形式出现在对话里', finalText.includes('本轮提交了'))
record('界面无「握手失败」', !finalText.includes('握手失败'))

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
  console.log('\n--- 观测 ---')
  console.log(JSON.stringify(observations, null, 2))
  console.log('\n--- 主进程输出（尾部）---')
  console.log(mainOut.split(/\r?\n/).filter((l) => l.trim()).slice(-20).join('\n'))
}
process.exit(failed.length === 0 ? 0 : 1)
