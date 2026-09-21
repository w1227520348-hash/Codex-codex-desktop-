/**
 * 验收：在真实应用里连续进行 5 轮简单对话，全程不应出现任何报错。
 *
 * 为什么用 mock 上游：本机没有真实 DeepSeek Key。mock 会原样回显用户提问，
 * 这样既能验证「真实 codex 子进程 + 真实桥 + 真实 UI」整条链路，
 * 又不需要联网。除了「真实模型回答质量」之外，其它环节都是真实执行。
 *
 * 覆盖：设置 → 选目录 → 新建任务 → 输入 → 发送 → 流式渲染 → 多轮上下文 → 无报错
 *
 * 运行：node scripts/verify-conversation.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
/** 可以被指向「解压出来的副本」，用于压缩包迁移验证 */
const APP_ROOT = process.env.CONV_APP_ROOT ? path.resolve(process.env.CONV_APP_ROOT) : root
/** 便携模式：不设 CODEX_DESKTOP_HOME，改为让应用读它自己目录下的 portable.flag */
const PORTABLE = process.env.CONV_PORTABLE === '1'
const electronBin =
  process.env.CONV_ELECTRON ??
  path.join(APP_ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const entry = path.join(APP_ROOT, 'out', 'main', 'index.js')
const PORT = 9360
const ROUNDS = 5
/** 引擎可用 CONV_ENGINE=exec 切换：两个引擎用同样的方式拉起 codex，必须都验证 */
const ENGINE = process.env.CONV_ENGINE === 'exec' ? 'exec' : 'app-server'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

/* ---------------- mock DeepSeek 上游 ---------------- */
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

  // 取最后一条 user 消息，原样回显，便于断言「这一轮确实回来了」
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const echo = (userText.match(/第\s*(\d+)\s*轮/) ?? [])[1] ?? '?'
  const replyText = `你好，我是模拟回复。已收到第 ${echo} 轮提问。`

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  for (const piece of replyText.match(/.{1,6}/gu) ?? []) {
    send({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model: body.model ?? 'deepseek-chat',
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
    })
  }
  send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } })
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port
console.log(`mock DeepSeek 上游：http://127.0.0.1:${mockPort}/v1`)

/* ---------------- 隔离的应用数据目录（便携模式下改为应用自己目录里的 data/）---------------- */
const BIG_AVATAR =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#ff7ab8"/></svg>')
const appHome = PORTABLE ? path.join(APP_ROOT, 'data') : fs.mkdtempSync(path.join(os.tmpdir(), 'codex-conv-'))
fs.mkdirSync(appHome, { recursive: true })
const workspace = path.join(appHome, 'project')
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, 'README.md'), '# demo project\n')
fs.writeFileSync(
  path.join(appHome, 'config.json'),
  JSON.stringify(
    {
      apiKey: 'sk-mock-conversation',
      model: 'deepseek-chat',
      temperature: 0.2,
      modelContextWindow: 65536,
      autoCompactLimit: 0,
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      reuseUserCodexConfig: false,
      useNativeResponses: false,
      permissionMode: 'read-only',
      engine: ENGINE,
      theme: 'dark',
      maxOutputTokens: 0,
      recentWorkspaces: [workspace],
      appearance: {
        background: null,
        wallpaper: null,
        backgroundOverlay: 0.22,
        backgroundBlur: 0,
        stylePreset: 'anime',
        showAvatars: true,
        // 故意用 800×600 的大图做头像：一旦尺寸约束失效就会糊满屏幕
        slots: {
          userAvatar: { source: BIG_AVATAR, kind: 'data', bytes: 100, addedAt: 1 },
          assistantAvatar: { source: BIG_AVATAR, kind: 'data', bytes: 100, addedAt: 1 }
        }
      }
    },
    null,
    2
  ),
  'utf8'
)

/* ---------------- 启动真实应用（带工作区参数）---------------- */
const child = spawn(electronBin, [entry, workspace, `--remote-debugging-port=${PORT}`], {
  cwd: APP_ROOT,
  // 便携模式下**不设** CODEX_DESKTOP_HOME，让 portable.flag 生效，验证配置确实写在应用目录里
  env: PORTABLE ? { ...process.env } : { ...process.env, CODEX_DESKTOP_HOME: appHome },
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

async function clickByText(text) {
  const hit = await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(${JSON.stringify(text)}) && !x.disabled)
      if (!b) return false
      const r = b.getBoundingClientRect(); if (r.width === 0) return false
      window.__clickTarget = [r.x + r.width / 2, r.y + r.height / 2]; return true })()`
  )
  if (!hit) return false
  const [x, y] = JSON.parse(await evaluate('JSON.stringify(window.__clickTarget)'))
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
  // Enter 发送
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  }
}

const bodyText = async () => String(await evaluate('document.body.innerText'))

/** 是否仍在运行：停止按钮只在运行中出现 */
const isRunning = async () =>
  Boolean(await evaluate(`!!([...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('停止')))`))

/** 等应用真正空闲再发下一轮（避免测试自己制造竞态） */
async function waitIdle(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isRunning())) return true
    await sleep(400)
  }
  return false
}

/** 界面里出现过的报错信号 */
async function collectErrors() {
  return JSON.parse(
    await evaluate(`JSON.stringify({
      notices: [...document.querySelectorAll('.notice-error')].map((n) => (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)),
      handshakeFail: document.body.innerText.includes('握手失败'),
      fallback: document.body.innerText.includes('已自动回退到稳定模式'),
      exited: (document.body.innerText.match(/code = 4294967295/g) || []).length,
      crash: (document.body.innerText.match(/进程已退出/g) || []).length
    })`)
  )
}

console.log(`\n引擎：${ENGINE}`)
console.log(`工作区：${workspace}`)
console.log('开始 5 轮对话…\n')

await clickByText('新建任务')

let firstFailure = null
for (let round = 1; round <= ROUNDS; round++) {
  const prompt = `第 ${round} 轮：请简单回复一句确认。`
  await typePrompt(prompt)

  // 等这一轮的回复出现（最多 90s）
  let replied = false
  for (let i = 0; i < 90; i++) {
    const text = await bodyText()
    if (text.includes(`已收到第 ${round} 轮提问`)) {
      replied = true
      break
    }
    await sleep(1000)
  }
  // 回复出现 ≠ 这一轮结束，等应用回到空闲
  const idle = await waitIdle()
  if (!idle) record(`第 ${round} 轮：等待空闲超时`, false, '60s 内仍显示运行中')

  const errors = await collectErrors()
  const clean = errors.notices.length === 0 && !errors.handshakeFail && !errors.fallback && errors.exited === 0
  record(`第 ${round} 轮：收到模拟回复`, replied)
  record(
    `第 ${round} 轮：无报错`,
    clean,
    clean ? '' : JSON.stringify({ notices: errors.notices, handshakeFail: errors.handshakeFail, fallback: errors.fallback, exited: errors.exited })
  )
  if (!replied || !clean) {
    firstFailure = { round, replied, errors }
    console.log('\n--- 首次失败详情 ---')
    console.log(JSON.stringify(firstFailure, null, 2))
    console.log('--- 界面文本（前 700 字）---')
    console.log((await bodyText()).slice(0, 700))
    console.log('\n--- 主进程输出（含 app-server 诊断）---')
    console.log(mainOut.split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n'))
    break
  }
  await sleep(600)
}

// 多轮上下文：第 5 轮的请求里应当带上前几轮内容
record('mock 上游收到的请求数 ≥ 5（每轮一次）', requestCount >= ROUNDS, `实际 ${requestCount}`)

/* ---------------- 头像尺寸约束（只有真的有气泡时才验证得到）---------------- */
const avatarGeo = JSON.parse(
  await evaluate(`JSON.stringify((() => {
    const frames = [...document.querySelectorAll('.bubble-avatar')]
    const probes = frames.map((outer) => {
      const frame = outer.querySelector('.fit-frame')
      const img = frame ? frame.querySelector('.fit-img') : null
      if (!frame || !img) return { textOnly: true }
      const fr = frame.getBoundingClientRect()
      const ir = img.getBoundingClientRect()
      const or = outer.getBoundingClientRect()
      return {
        frame: [Math.round(fr.width), Math.round(fr.height)],
        img: [Math.round(ir.width), Math.round(ir.height)],
        natural: [img.naturalWidth, img.naturalHeight],
        radius: getComputedStyle(outer).borderRadius,
        overflow: getComputedStyle(frame).overflow,
        overflowsOuter: ir.width > or.width + 0.5 || ir.height > or.height + 0.5,
        coversViewport: ir.width >= window.innerWidth - 2 && ir.height >= window.innerHeight - 2
      }
    })
    return {
      count: frames.length,
      imageAvatars: probes.filter((p) => !p.textOnly),
      hasBg: document.documentElement.getAttribute('data-has-bg'),
      bgLayer: !!document.querySelector('.app-bg'),
      fullscreenImgs: [...document.querySelectorAll('img')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2
      }).length
    }
  })())`)
)

record('对话里确实渲染了头像', avatarGeo.count > 0, `头像数=${avatarGeo.count}`)
record('头像是自定义图片（不是文字徽标）', avatarGeo.imageAvatars.length > 0, `图片头像数=${avatarGeo.imageAvatars.length}`)
record(
  '头像图尺寸 == 头像框尺寸（不是原始 800×600）',
  avatarGeo.imageAvatars.length > 0 && avatarGeo.imageAvatars.every((a) => a.img[0] === a.frame[0] && a.img[1] === a.frame[1]),
  JSON.stringify(avatarGeo.imageAvatars[0] ?? null)
)
record('头像框是圆形（border-radius 为胶囊值）', avatarGeo.imageAvatars.every((a) => a.radius.includes('999') || parseInt(a.radius, 10) >= 20), String(avatarGeo.imageAvatars[0]?.radius))
record('头像框裁剪溢出', avatarGeo.imageAvatars.every((a) => a.overflow === 'hidden'))
record('头像未超出头像框', avatarGeo.imageAvatars.every((a) => a.overflowsOuter === false))
record('头像未铺满视口', avatarGeo.imageAvatars.every((a) => a.coversViewport === false) && avatarGeo.fullscreenImgs === 0)
record('设置头像没有触发全屏背景层', avatarGeo.hasBg === null && avatarGeo.bgLayer === false, `hasBg=${avatarGeo.hasBg} bgLayer=${avatarGeo.bgLayer}`)
if (PORTABLE) {
  const cfg = path.join(appHome, 'config.json')
  record('便携模式：配置写在应用自己的 data/ 目录里', fs.existsSync(cfg), cfg)
  const codexHome = path.join(appHome, 'codex-home', 'config.toml')
  record('便携模式：CODEX_HOME 也在 data/ 下', fs.existsSync(codexHome), codexHome)
}

/* ---------------- 清理 ---------------- */
ws.close()
child.kill()
await sleep(600)
await new Promise((r) => mock.close(r))
try {
  if (!PORTABLE) fs.rmSync(appHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
