/**
 * 验证「压缩包 → 解压到别处 → 仍然可用」。
 *
 * 做的是真事：
 *   1. 把便携包解压到一个**完全不同的目录**
 *   2. 检查解压结果是否完整（产物 / Electron 运行时 / 随包 codex / 便携标记）
 *   3. 从**解压出来的那份**启动应用，跑 5 轮对话
 *   4. 断言没有任何报错，并确认配置写在了「解压目录/data」里（便携模式生效）
 *
 * 运行：node scripts/verify-portable.mjs [zip路径]
 *       不带参数时先自动打一个包。
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 1. 拿到 zip ---------------- */
let zipPath = process.argv[2] ? path.resolve(process.argv[2]) : null
if (!zipPath) {
  console.log('未指定 zip，先自动打包…\n')
  const packed = spawnSync(process.execPath, [path.join(here, 'pack-portable.mjs')], { cwd: root, stdio: 'inherit' })
  if (packed.status !== 0) {
    console.error('打包失败')
    process.exit(2)
  }
  const packDir = path.join(root, '.pack')
  const candidates = fs.readdirSync(packDir).filter((f) => f.startsWith('codex-desktop-portable') && f.endsWith('.zip'))
  if (candidates.length === 0) {
    console.error('找不到打包产物')
    process.exit(2)
  }
  zipPath = path.join(packDir, candidates.sort().at(-1))
}
if (!fs.existsSync(zipPath)) {
  console.error(`zip 不存在：${zipPath}`)
  process.exit(2)
}
console.log(`\n便携包：${zipPath}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(0)} MB）`)

/* ---------------- 2. 解压到完全不同的目录 ---------------- */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-portable-unzip-'))
console.log(`解压到：${sandbox}`)
const unzip = spawnSync('tar', ['-x', '-f', zipPath, '-C', sandbox], { stdio: 'ignore' })
if (unzip.status !== 0) {
  // 退回 PowerShell 解压
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${sandbox}' -Force`],
    { stdio: 'ignore' }
  )
  if (ps.status !== 0) {
    console.error('解压失败')
    process.exit(2)
  }
}

const entries = fs.readdirSync(sandbox).filter((f) => fs.statSync(path.join(sandbox, f)).isDirectory())
const appRoot = path.join(sandbox, entries[0] ?? '')
console.log(`解压后的应用目录：${appRoot}\n`)

/* ---------------- 3. 完整性检查（这一步正是「迁移后能不能用」的关键）---------------- */
record('顶层启动器存在', fs.existsSync(path.join(appRoot, '启动驾驶舱.cmd')))
record('使用说明存在', fs.existsSync(path.join(appRoot, '首次使用.txt')))
record('便携标记存在（配置会写在同目录）', fs.existsSync(path.join(appRoot, 'portable.flag')))
record('构建产物完整', fs.existsSync(path.join(appRoot, 'out', 'main', 'index.js')) && fs.existsSync(path.join(appRoot, 'out', 'renderer', 'index.html')))
const electronRel = process.platform === 'win32' ? 'electron.exe' : 'electron'
record('Electron 运行时随包携带', fs.existsSync(path.join(appRoot, 'node_modules', 'electron', 'dist', electronRel)))
const codexEntry = path.join(appRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
record('codex CLI 随包携带', fs.existsSync(codexEntry), codexEntry)
record(
  'codex 平台原生二进制随包携带',
  fs.existsSync(path.join(appRoot, 'node_modules', '@openai', 'codex-win32-x64')) ||
    fs.existsSync(path.join(appRoot, 'node_modules', '@openai', 'codex', 'node_modules'))
)
record('.npmrc 随包携带（重新安装时走国内镜像）', fs.existsSync(path.join(appRoot, '.npmrc')))

// 解压出来的 codex 必须真能跑（不是只看文件在不在）
const probe = spawnSync(process.execPath, [codexEntry, '--version'], { encoding: 'utf8' })
record('解压后的 codex 可执行', probe.status === 0, String(probe.stdout || probe.stderr).trim().slice(0, 60))

/* ---------------- 4. 从解压出来的副本跑 5 轮对话 ---------------- */
console.log('\n从「解压出来的副本」启动应用并跑 5 轮对话…\n')
const conv = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'verify-conversation.mjs')],
  {
    cwd: root,
    env: { ...process.env, CONV_APP_ROOT: appRoot, CONV_PORTABLE: '1' },
    encoding: 'utf8'
  }
)
const output = `${conv.stdout ?? ''}${conv.stderr ?? ''}`
for (const line of output.split(/\r?\n/)) {
  if (/^(引擎|PASS|FAIL|=== 结果|失败项)/.test(line.trim())) console.log(`  ${line.trim()}`)
}
record('解压后 5 轮对话无报错', conv.status === 0, conv.status === 0 ? '对话全部通过' : `退出码 ${conv.status}`)

/* ---------------- 5. 便携模式落盘检查 ---------------- */
record('配置写在解压目录的 data/ 下（便携模式生效）', fs.existsSync(path.join(appRoot, 'data', 'config.json')))
record('会话历史也在 data/ 下', fs.existsSync(path.join(appRoot, 'data', 'sessions')))

/* ---------------- 清理 ---------------- */
try {
  fs.rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
