/**
 * 打包成「解压即用」的压缩包。
 *
 * 产物结构（解压后直接双击「启动驾驶舱.cmd」即可）：
 *   codex-desktop-portable/
 *   ├─ 启动驾驶舱.cmd        ← 双击启动
 *   ├─ 首次使用.txt          ← 给接收方的说明
 *   ├─ portable.flag         ← 便携模式标记：配置/会话写在同目录 data/ 下
 *   ├─ out/                  ← 已构建好的产物
 *   ├─ node_modules/         ← 含 Electron 运行时**与随包携带的 codex**
 *   ├─ launch/ docs/ src/ test/ scripts/
 *   ├─ package.json .npmrc README.md
 *
 * 运行：npm run pack:portable
 *   加 --slim 只打源码（目标机需要 npm install && npm run build）
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SLIM = process.argv.includes('--slim')
const NAME = 'codex-desktop-portable'

const log = (msg) => console.log(`[pack] ${msg}`)
const fail = (msg) => {
  console.error(`[pack] ✘ ${msg}`)
  process.exit(1)
}

/* ---------------- 0. 前置检查 ---------------- */
log(`应用根目录：${root}`)

if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  log('缺少构建产物，先执行 npm run build …')
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (built.status !== 0) fail('构建失败')
}

const bundledCodex = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const bundledPlatform = path.join(root, 'node_modules', '@openai', 'codex-win32-x64')
if (!SLIM) {
  if (!fs.existsSync(bundledCodex)) {
    fail('缺少随包携带的 codex：请先执行 npm install @openai/codex@0.154.0 --save')
  }
  // 关键：只有 @openai/codex 而没有平台原生二进制时，解压后 codex 跑不起来
  const platformOk =
    fs.existsSync(bundledPlatform) ||
    fs.existsSync(path.join(root, 'node_modules', '@openai', 'codex', 'node_modules'))
  if (!platformOk) {
    fail('缺少 codex 的平台原生二进制（@openai/codex-win32-x64 等），解压后无法运行')
  }
  const probe = spawnSync(process.execPath, [bundledCodex, '--version'], { encoding: 'utf8' })
  if (probe.status !== 0) fail(`随包携带的 codex 不可用：${(probe.stderr || '').slice(0, 200)}`)
  log(`随包携带的 codex 可用：${String(probe.stdout).trim()}`)
}

/* ---------------- 1. 准备暂存目录 ---------------- */
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const stageRoot = path.join(root, '.pack')
const stage = path.join(stageRoot, NAME)
fs.rmSync(stageRoot, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
log(`暂存目录：${stage}`)

const COPY = ['out', 'src', 'docs', 'launch', 'scripts', 'test', 'package.json', 'package-lock.json', '.npmrc', 'README.md', '.gitignore']
for (const item of COPY) {
  const from = path.join(root, item)
  if (!fs.existsSync(from)) {
    log(`跳过（不存在）：${item}`)
    continue
  }
  fs.cpSync(from, path.join(stage, item), { recursive: true })
}
log(`已复制源码与产物：${COPY.join(', ')}`)

if (!SLIM) {
  log('复制 node_modules（含 Electron 运行时与 codex，体积较大，请耐心）…')
  // robocopy 比 Copy-Item 快很多；退出码 0~7 都算成功
  const rc = spawnSync(
    'robocopy',
    [path.join(root, 'node_modules'), path.join(stage, 'node_modules'), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { stdio: 'ignore' }
  )
  if (rc.status === null || rc.status > 7) fail(`robocopy 失败，退出码 ${rc.status}`)
  log('node_modules 复制完成')
}

/* ---------------- 2. 便携标记与启动入口 ---------------- */
fs.writeFileSync(path.join(stage, 'portable.flag'), 'portable\r\n', 'utf8')

// 顶层启动器：内容保持纯 ASCII（cmd.exe 会按 OEM 代码页读取文件，中文会乱码）
fs.writeFileSync(
  path.join(stage, '启动驾驶舱.cmd'),
  [
    '@echo off',
    'rem Top-level launcher for the portable package.',
    'rem Keep this file ASCII-only: cmd.exe reads .cmd in the OEM codepage.',
    'call "%~dp0launch\\codex-desktop.cmd" %*',
    ''
  ].join('\r\n'),
  'utf8'
)

fs.writeFileSync(
  path.join(stage, '首次使用.txt'),
  [
    'Codex 驾驶舱 —— 便携版使用说明',
    '======================================',
    '',
    '【怎么启动】',
    '  双击本目录下的「启动驾驶舱.cmd」即可。',
    '  （也可以右键文件夹 →「在 Codex 驾驶舱中打开」，但需先运行一次 launch\\install.ps1 注册）',
    '',
    '【第一次要做两件事】',
    '  1. 点左下角「设置」，填入你的 DeepSeek API Key（形如 sk-...），保存。',
    '  2. 点左下角「环境自检」，确认三项都是 ✔：',
    '       · codex CLI    —— 本包已内置，应显示 0.154.0',
    '       · DeepSeek API Key —— 应显示「已配置」',
    '       · 协议桥      —— 应显示本机地址',
    '     然后点「测试连通性」，看到「DeepSeek 连通正常」即可开始用。',
    '',
    '【为什么这个包能直接跑】',
    '  · node_modules 里带了 Electron 运行时，不需要 npm install',
    '  · node_modules/@openai/codex 里带了 codex CLI，不需要全局安装',
    '  · 本目录有 portable.flag，所以配置与会话历史都写在同目录的 data\\ 下',
    '',
    '【注意】',
    '  · 只能在同一操作系统/架构上使用（本包为 Windows x64）。跨系统请用 npm run pack:portable --slim 出源码包，',
    '    到目标机执行 npm install && npm run build。',
    '  · data\\config.json 里保存着你的 API Key，分享给别人前请删除整个 data\\ 目录。',
    '  · 请勿放在只读目录（如 Program Files）。若目录不可写，应用会自动退回 ~/.codex-desktop。',
    '  · 需要固定的终端命令 / 桌面快捷方式 / 右键菜单，运行一次：',
    '        powershell -ExecutionPolicy Bypass -File launch\\install.ps1',
    '',
    '【出问题先自查】',
    '  cd 到本目录后执行：',
    '        npm run diagnose:appserver        （若目标机没有 Node，用内置的 out 目录直接启动应用看「环境自检」）',
    ''
  ].join('\r\n'),
  'utf8'
)

/* ---------------- 3. 打 zip ---------------- */
const zipName = `${NAME}${SLIM ? '-slim' : ''}-${stamp}.zip`
const zipPath = path.join(stageRoot, zipName)
log(`正在压缩 → ${zipPath}`)

// 优先用 bsdtar（Win10+ 自带，长路径与大量小文件处理更好）
let tarOk = false
const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', stageRoot, NAME], { stdio: 'ignore' })
tarOk = tar.status === 0 && fs.existsSync(zipPath)
if (!tarOk) {
  log('tar 不可用，退回 Compress-Archive …')
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`],
    { stdio: 'ignore' }
  )
  if (ps.status !== 0 || !fs.existsSync(zipPath)) fail('压包失败（tar 与 Compress-Archive 都不可用）')
}

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(0)
log(`✔ 完成：${zipPath}（${mb} MB）`)
log('')
log('接收方只需：解压 → 双击「启动驾驶舱.cmd」→ 填 API Key')
log(`验证整包可用性：node scripts/verify-portable.mjs "${zipPath}"`)
