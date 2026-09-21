/**
 * 验证「在任意文件夹启动」：真的用启动器参数打开应用，并检查界面是否落在该目录。
 *
 * 运行：node scripts/verify-launch.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const entry = path.join(root, 'out', 'main', 'index.js')
const DEBUG_PORT = 9334

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

// 造一个特征明显的"被打开的文件夹"
const markerName = `codex-launch-verify-${Date.now().toString(36)}`
const targetDir = path.join(os.tmpdir(), markerName)
fs.mkdirSync(targetDir, { recursive: true })
fs.writeFileSync(path.join(targetDir, 'README.md'), '# 启动验证\n')

// 从一个完全不同的 cwd 启动，模拟「在任意文件夹启动」
const otherCwd = os.tmpdir()
console.log(`工作区参数：${targetDir}`)
console.log(`启动时 cwd：${otherCwd}\n`)

// 用 CODEX_DESKTOP_HOME 隔离应用数据目录：
// 这个脚本会触发 rememberWorkspace，不隔离就会往用户真实配置里写测试用的临时目录。
const fakeAppHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-verify-home-'))

const child = spawn(electronBin, [entry, targetDir, `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: otherCwd,
  env: { ...process.env, CODEX_DESKTOP_HOME: fakeAppHome },
  stdio: ['ignore', 'pipe', 'pipe']
})

let mainOut = ''
child.stdout.on('data', (d) => (mainOut += d.toString()))
child.stderr.on('data', (d) => (mainOut += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  console.error('无法连接渲染进程：')
  console.error(mainOut)
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
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
  }
})

await send('Runtime.enable')
await sleep(3000)

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result?.result?.value
}

const text = await evaluate('document.body.innerText.replace(/\\s+/g," ")')
const launchInfo = await evaluate('(async () => JSON.stringify(await window.api.getLaunchInfo()))()')

console.log(`界面文本（截断）：${String(text).slice(0, 300)}\n`)
console.log(`启动信息：${launchInfo}\n`)

record('界面显示了被打开的目录', String(text).includes(markerName), String(text).includes(markerName) ? '找到目录名' : '界面里没有该目录')
record('不再显示「未选择目录」', !String(text).includes('未选择目录'))
record('主进程解析出了启动工作区', String(launchInfo).includes(markerName), String(launchInfo))
record('标记为「由参数启动」', String(launchInfo).includes('"fromArgument":true'))

ws.close()
child.kill()
await sleep(600)
try {
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.rmSync(fakeAppHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
process.exit(failed.length === 0 ? 0 : 1)
