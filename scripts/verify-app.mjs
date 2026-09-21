/**
 * 启动验证：真的把 Electron 应用跑起来，并通过 CDP 检查渲染层是否成功挂载。
 *
 * 只靠「进程没崩」不足以说明 UI 正常，所以这里用 --remote-debugging-port
 * 连进渲染进程，实际读取 DOM 内容与运行时异常。
 *
 * 运行：node scripts/verify-app.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const DEBUG_PORT = 9333

if (!fs.existsSync(electronBin)) {
  console.error(`找不到 Electron 可执行文件：${electronBin}`)
  process.exit(2)
}

const child = spawn(electronBin, [path.join(root, 'out', 'main', 'index.js'), `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: root,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let mainOut = ''
let mainErr = ''
child.stdout.on('data', (d) => (mainOut += d.toString()))
child.stderr.on('data', (d) => (mainErr += d.toString()))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findPageTarget() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return null
}

const target = await findPageTarget()
if (!target) {
  console.error('无法连接到渲染进程（CDP）。主进程输出：')
  console.error(mainOut)
  console.error(mainErr)
  child.kill()
  process.exit(1)
}

console.log(`已连接渲染进程：${target.title} — ${target.url}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const exceptions = []
const consoleErrors = []
let nextId = 1

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params?.exceptionDetails?.exception?.description ?? JSON.stringify(message.params))
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push((message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

await send('Runtime.enable')
await send('Log.enable')
await sleep(2500)

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result?.result?.value
}

const mounted = await evaluate('document.querySelector("#root") ? document.querySelector("#root").children.length : -1')
const text = await evaluate('document.body.innerText.replace(/\\s+/g," ").slice(0, 600)')
const panels = await evaluate(
  'JSON.stringify({sidebar: !!document.querySelector("aside, .sidebar"), composer: !!document.querySelector("textarea"), status: !!document.querySelector(".status-bar, header"), buttons: document.querySelectorAll("button").length})'
)

console.log('\n=== 渲染层检查 ===')
console.log(`#root 子节点数：${mounted}`)
console.log(`面板结构：${panels}`)
console.log(`可见文本：${text}`)

console.log('\n=== 运行时异常 ===')
console.log(exceptions.length === 0 ? '(无)' : exceptions.join('\n---\n'))
console.log('\n=== console.error ===')
console.log(consoleErrors.length === 0 ? '(无)' : consoleErrors.join('\n---\n'))

console.log('\n=== 主进程输出（关键行）===')
for (const line of mainOut.split(/\r?\n/).filter((l) => /bridge|协议桥|错误|error/i.test(l)).slice(0, 15)) {
  console.log(`  ${line}`)
}

const bridgeStarted = /协议桥已启动/.test(mainOut) || /\[bridge\] 协议桥已启动/.test(mainOut)
const ok = mounted > 0 && exceptions.length === 0
console.log(`\n=== 结论 ===`)
console.log(`渲染层挂载：${mounted > 0 ? '成功' : '失败'}`)
console.log(`协议桥启动：${bridgeStarted ? '成功' : '未在日志中看到'}（未配置 API Key 时也可能不启动）`)
console.log(`渲染异常：${exceptions.length}`)
console.log(ok ? '应用启动验证：通过' : '应用启动验证：失败')

ws.close()
child.kill()
await sleep(500)
process.exit(ok ? 0 : 1)
