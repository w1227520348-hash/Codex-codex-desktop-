/**
 * app-server 启动体检。
 *
 * 这个脚本回答四个问题（把原始排查清单落到本项目的真实架构上）：
 *   1. 入口文件路径与 cwd 是否正确 —— 用应用真实的 resolveCodexCli / prepareCodexRuntime 解析
 *   2. 依赖是否完整 —— @openai/codex 包 + 当前平台的原生二进制
 *   3. 监听端口是否被占用 —— app-server 默认走 **stdio**（不是端口），另外检查本应用自己起的
 *      协议桥端口（它用 port 0 让系统分配，冲突概率为零）
 *   4. 启动后的退出码到底是什么意思 —— 现场起一次，解码退出码并打印 stderr
 *
 * 运行：npm run diagnose:appserver
 * 想看更啰嗦的引擎日志：把 CODEX_DESKTOP_DEBUG=1 一起设上。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// 隔离应用数据目录：本脚本会生成 config.toml，绝不能动用户真实配置
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diagnose-'))
process.env.CODEX_DESKTOP_HOME = path.join(probeHome, 'appdata')

const alias = { '@shared/types': path.join(root, 'src/shared/types.ts') }
const tmp = path.join(root, '.tmp')
fs.mkdirSync(tmp, { recursive: true })

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: path.join(tmp, outfile),
    alias,
    logLevel: 'warning'
  })
  return import(pathToFileURL(path.join(tmp, outfile)).href)
}

const ok = (v) => (v ? '✔' : '✘')
const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`)

console.log('══════════ app-server 启动体检 ══════════')
console.log(`平台: ${os.type()} ${os.release()} (${process.arch})   Node: ${process.version}`)

/* ---------------- 1. 入口文件与 cwd ---------------- */
console.log('\n【1】入口文件路径与 cwd')
const { resolveCodexCli } = await bundle('src/core/codexCli.ts', 'diag-cli.mjs')
const cli = await resolveCodexCli(true)
if (!cli) {
  console.log(`  ${ok(false)} 找不到 codex CLI 入口`)
  console.log('     修复：npm i -g @openai/codex --registry=https://registry.npmmirror.com')
  process.exit(1)
}
line('入口文件', cli.entry)
line('文件存在', `${ok(fs.existsSync(cli.entry))} ${fs.existsSync(cli.entry)}`)
line('Node 运行时', cli.nodePath)
line('版本', String(cli.version))
line('解析方式', 'npm root -g → node_modules/@openai/codex/bin/codex.js（用 node 直接跑，避开 .ps1/.cmd 的引号问题）')

const workspace = fs.mkdtempSync(path.join(probeHome, 'ws-'))
fs.writeFileSync(path.join(workspace, 'README.md'), '# diagnose\n')
line('本次 cwd', workspace)

/* ---------------- 2. 依赖完整性 ---------------- */
console.log('\n【2】依赖完整性（@openai/codex 包）')
const pkgDir = path.dirname(path.dirname(cli.entry)) // .../node_modules/@openai/codex
const pkgJsonPath = path.join(pkgDir, 'package.json')
let pkg = null
try {
  pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
} catch {
  /* ignore */
}
line('package.json', `${ok(Boolean(pkg))} ${pkgJsonPath}`)
if (pkg) {
  line('声明版本', String(pkg.version))
  const opt = pkg.optionalDependencies ?? {}
  const want = `@openai/codex-${process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`
  line('平台包', `${want} → ${opt[want] ? '已声明' : '未声明'}`)
  const vendorDir = path.join(pkgDir, 'node_modules', want, 'vendor')
  let binaries = []
  try {
    binaries = fs.readdirSync(vendorDir, { recursive: true }).filter((f) => String(f).endsWith('.exe'))
  } catch {
    /* ignore */
  }
  line('原生二进制', `${ok(binaries.length > 0)} ${binaries.length} 个（${path.join(pkgDir, 'node_modules', want, 'vendor')}）`)
  if (binaries.length > 0) line('示例', String(binaries[0]))
  if (!pkg.optionalDependencies || binaries.length === 0) {
    console.log('     修复：重装该包（缺失平台二进制时 codex 无法执行任何子命令）')
  }
}

/* ---------------- 3. 端口 / 传输方式 ---------------- */
console.log('\n【3】监听端口是否被占用')
const help = await new Promise((resolve) => {
  const child = spawn(cli.nodePath, [cli.entry, 'app-server', '--help'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (out += d.toString()))
  child.on('close', () => resolve(out))
})
const stdioDefault = /--listen[\s\S]{0,400}?default:\s*stdio:\/\//.test(help) || help.includes('`stdio://` (default)')
line('app-server 传输', stdioDefault ? 'stdio://（默认，**不监听任何端口**）' : '未能确认')
line('结论', stdioDefault ? '不存在端口占用问题；本应用也没有传 --listen' : '请手工确认')

// 本应用自己的协议桥端口：用 port 0 让系统分配
const { startBridge } = await bundle('src/core/bridge/server.ts', 'diag-bridge.mjs')
const bridge = await startBridge({
  apiKey: 'sk-diagnose',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxOutputTokens: 0
})
line('协议桥端口', `${bridge.port}（bind 127.0.0.1:0 → 系统分配，冲突概率≈0）`)
let bridgeHealthy = false
try {
  const res = await fetch(`${bridge.baseUrl}/health`)
  bridgeHealthy = res.ok
} catch {
  /* ignore */
}
line('桥健康检查', `${ok(bridgeHealthy)} ${bridgeHealthy}`)
await bridge.close()

/* ---------------- 4. 现场启动 + 退出码解码 ---------------- */
console.log('\n【4】现场启动一次 app-server（解码退出码）')
const { prepareCodexRuntime } = await bundle('src/core/codexHome.ts', 'diag-home.mjs')
const runtime = prepareCodexRuntime({
  settings: {
    apiKey: 'sk-diagnose',
    model: 'deepseek-chat',
    temperature: 0.2,
    modelContextWindow: 65536,
    autoCompactLimit: 0,
    baseUrl: 'http://127.0.0.1:1/v1',
    reuseUserCodexConfig: false,
    useNativeResponses: false,
    permissionMode: 'read-only',
    engine: 'app-server',
    theme: 'dark',
    maxOutputTokens: 0,
    recentWorkspaces: [],
    appearance: null
  },
  bridgeBaseUrl: 'http://127.0.0.1:1/v1',
  workspace
})
line('CODEX_HOME', runtime.codexHome)
line('config.toml', `${ok(fs.existsSync(path.join(runtime.codexHome, 'config.toml')))} ${path.join(runtime.codexHome, 'config.toml')}`)
line('provider', runtime.providerBaseUrl)

const args = [cli.entry, 'app-server', ...runtime.overrides.flatMap((o) => ['-c', o])]
console.log(`  argv: node ${args.join(' ')}`)
console.log('  （可用 CODEX_DESKTOP_DEBUG=1 让应用运行时也打印同样的信息）')

const child = spawn(cli.nodePath, args, {
  cwd: workspace,
  env: { ...process.env, ...runtime.env, CODEX_HOME: runtime.codexHome, TERM: 'dumb' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
let stdout = ''
let stderr = ''
let responded = false
child.stdout.on('data', (d) => {
  stdout += d.toString()
  if (stdout.includes('"id":1')) responded = true
})
child.stderr.on('data', (d) => (stderr += d.toString()))
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-desktop-diagnose', version: '1' } } }) + '\n')

const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ state: 'alive', code: null, signal: null }), 12000)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    resolve({ state: 'exited', code, signal })
  })
})

function decodeExitCode(code) {
  if (code === null) return '仍在运行（正常）'
  const unsigned = code >>> 0
  if (unsigned === 4294967295) {
    return `${unsigned}（= -1）：**进程自己调用了 exit(-1)**。实测被应用 taskkill 强杀得到的码是 1，` +
      `所以这不是被我们杀掉的，而是 app-server 自身退出。优先看下面 stderr。`
  }
  if (code === 1) return '1：可能是应用主动 taskkill 结束（换工作区/空闲回收/退出应用），或进程自身报错退出'
  if (code === 0) return '0：正常退出'
  return `${code}（无符号 ${unsigned}）`
}

line('initialize', `${ok(responded)} ${responded ? '有响应 → 握手成功' : '无响应'}`)
line('结果', outcome.state === 'alive' ? '存活（启动正常）' : `已退出 code=${outcome.code} signal=${outcome.signal}`)
line('退出码含义', decodeExitCode(outcome.code))
if (stderr.trim()) {
  console.log('  stderr:')
  for (const l of stderr.trim().split('\n').slice(0, 15)) console.log(`    ${l}`)
} else {
  console.log('  stderr: （空）')
}

if (outcome.state === 'alive') child.kill()
else console.log('\n  提示：进程自行 exit(-1) 且 stderr 为空，通常是原生二进制/运行时层面的问题；' +
  '\n        可尝试重装 codex 包（npm i -g @openai/codex --registry=https://registry.npmmirror.com）后重跑本体检。')

/* ---------------- 清理 ---------------- */
try {
  fs.rmSync(probeHome, { recursive: true, force: true })
} catch {
  /* ignore */
}
console.log('\n══════════ 体检结束 ══════════')
process.exit(0)
