/**
 * 定位本机的 codex CLI。
 *
 * 关键：不要直接用 `codex`（Windows 上是 .ps1/.cmd，spawn 需要 shell，参数引号会被二次解释）。
 * 而是找到 `@openai/codex/bin/codex.js`，用 `node <entry> ...` 直接跑，参数走数组传递，最稳。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { bundledCodexEntry } from './appPaths'

const execFileAsync = promisify(execFile)

export interface CodexCli {
  /** node 可执行文件 */
  nodePath: string
  /** codex.js 绝对路径 */
  entry: string
  /** 版本号，例如 0.154.0 */
  version: string | null
  /** 展示给用户的路径 */
  displayPath: string
  /**
   * nodePath 是不是 Electron 可执行文件（打包/开发运行时都是）。
   *
   * 关键：在 Electron 里 `process.execPath` 指向 electron.exe，直接拿它去跑 codex.js
   * 会让**子进程启动一整套 Chromium**。Chromium 会去抢父进程已占用的 userData/Cache 目录，
   * 报 "Unable to create cache / 拒绝访问 (0x5)" 后立刻退出（Windows 上退出码 -1，
   * 且 stderr 为空 —— 极难自查）。所以必须给子进程加 ELECTRON_RUN_AS_NODE=1，
   * 让它以纯 Node 模式运行，完全不碰 Chromium。
   */
  runAsNode: boolean
}

const ENTRY_SUFFIX = path.join('@openai', 'codex', 'bin', 'codex.js')

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

async function npmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('npm', ['root', '-g'], { timeout: 20000, windowsHide: true })
    const root = stdout.trim()
    return root.length > 0 ? root : null
  } catch {
    return null
  }
}

async function whichCodex(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['codex'], {
      timeout: 20000,
      windowsHide: true
    })
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

let cached: CodexCli | null = null

export async function resolveCodexCli(force = false): Promise<CodexCli | null> {
  if (cached && !force) return cached

  const candidates: string[] = []
  if (process.env.CODEX_DESKTOP_CODEX_JS) candidates.push(process.env.CODEX_DESKTOP_CODEX_JS)

  // 优先用**随包携带**的 codex：这样压缩包解压到新机器即可用，不要求先装全局 CLI
  const bundled = bundledCodexEntry()
  if (bundled) candidates.push(bundled)

  const globalRoot = await npmGlobalRoot()
  if (globalRoot) candidates.push(path.join(globalRoot, ENTRY_SUFFIX))

  for (const found of await whichCodex()) {
    // 例如 C:\Program Files\nodejs\codex.cmd → C:\Program Files\nodejs\node_modules\@openai\codex\bin\codex.js
    const dir = path.dirname(found)
    candidates.push(path.join(dir, 'node_modules', ENTRY_SUFFIX))
    candidates.push(path.join(dir, '..', 'lib', 'node_modules', ENTRY_SUFFIX))
  }

  // 在 Electron 里 process.execPath 是 electron.exe；用它跑 codex.js 必须走纯 Node 模式
  const runAsNode = Boolean(process.versions.electron)
  const childEnv = runAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env

  /**
   * 逐个候选做**可达性验证**（跑一次 --version），返回第一个能用的。
   * 这一步很关键：压缩包迁移的场景下，「随包携带的 codex」可能缺了平台原生二进制
   * （例如只拷了 @openai/codex 而漏了 @openai/codex-win32-x64）。
   * 如果不验证就直接采用，应用会选到一个坏入口并彻底不可用 —— 必须能自动退回全局安装。
   */
  for (const candidate of candidates) {
    const entry = firstExisting([candidate])
    if (!entry) continue

    let version: string | null = null
    try {
      const { stdout } = await execFileAsync(process.execPath, [entry, '--version'], {
        timeout: 30000,
        windowsHide: true,
        env: childEnv
      })
      const match = stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)
      version = match ? match[1] : stdout.trim() || null
    } catch {
      // 这个候选不可用，试下一个
      continue
    }
    if (!version) continue

    cached = { nodePath: process.execPath, entry, version, displayPath: entry, runAsNode }
    return cached
  }

  cached = null
  return null
}

/** 供子进程使用的环境变量：Electron 运行时必须带上 ELECTRON_RUN_AS_NODE */
export function codexChildNodeEnv(cli: CodexCli): Record<string, string> {
  return cli.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

export function getCachedCodexCli(): CodexCli | null {
  return cached
}
