/**
 * exec 引擎：spawn 真实的 `codex exec --json` 子进程，逐行解析事件流。
 *
 * 这是应用的主驱动通道（M1）。审批按钮由 M3 的 app-server 引擎补充，
 * 本引擎下「权限」通过 `-s read-only|workspace-write|danger-full-access` 控制，
 * 被沙箱拒绝的动作由内置桥嗅探后补报 notice(level=denied)。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { AppSettings, HarnessEvent, PermissionMode } from '../shared/types'
import { codexChildNodeEnv, resolveCodexCli } from './codexCli'
import { prepareCodexRuntime, type CodexRuntime } from './codexHome'
import { createLineSplitter, mapExecEvent } from './eventParser'

export interface ExecTaskOptions {
  workspace: string
  prompt: string
  permissionMode: PermissionMode
  settings: AppSettings
  bridgeBaseUrl: string
  onEvent: (event: HarnessEvent) => void
  /** 已有 thread id：走 `codex exec resume` 续接同一段上下文 */
  resumeThreadId?: string | null
}

/** codex 在非 TTY 下的无害提示，丢弃以免污染界面 */
const STDERR_NOISE: RegExp[] = [/^Reading additional input from stdin\.\.\.$/i, /^\s*$/]

export class ExecEngine {
  private child: ChildProcess | null = null
  private runtime: CodexRuntime | null = null
  private cancelled = false
  /** 本次 run 的 codex thread id（供续接使用） */
  private threadId: string | null = null

  get isRunning(): boolean {
    return this.child !== null
  }

  get currentThreadId(): string | null {
    return this.threadId
  }

  get lastRuntime(): CodexRuntime | null {
    return this.runtime
  }

  /**
   * 开始一轮任务前必须同步调用：清掉上一轮的取消标记。
   * 之所以要在 start() 之外单独提供，是因为 start() 里有 await（找 CLI、写配置），
   * 用户可能在这个窗口里就点了「停止」。
   */
  reset(): void {
    this.cancelled = false
    this.threadId = null
  }

  async start(options: ExecTaskOptions): Promise<void> {
    // 启动窗口内被取消
    if (this.cancelled) {
      options.onEvent({ type: 'notice', level: 'warn', message: '任务在启动前已被取消。' })
      options.onEvent({ type: 'exit', code: null, signal: 'SIGTERM' })
      return
    }

    const cli = await resolveCodexCli()
    if (this.cancelled) {
      options.onEvent({ type: 'notice', level: 'warn', message: '任务在启动前已被取消。' })
      options.onEvent({ type: 'exit', code: null, signal: 'SIGTERM' })
      return
    }
    if (!cli) {
      options.onEvent({
        type: 'error',
        message: '未找到 codex CLI。请先安装：npm i -g @openai/codex --registry=https://registry.npmmirror.com',
        fatal: true
      })
      options.onEvent({ type: 'exit', code: null, signal: null })
      return
    }

    const runtime = prepareCodexRuntime({
      settings: options.settings,
      bridgeBaseUrl: options.bridgeBaseUrl,
      workspace: options.workspace
    })
    this.runtime = runtime

    // 续接上下文：`codex exec resume <thread-id> <prompt>`
    // 注意 resume 子命令**没有** -s/-C 参数（实测），所以沙箱必须用 -c sandbox_mode= 传，
    // 工作目录则靠子进程 cwd（codex 按 cwd 过滤可恢复的会话）。
    const resuming = Boolean(options.resumeThreadId)
    const args = resuming
      ? [
          cli.entry,
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          ...runtime.overrides.flatMap((override) => ['-c', override]),
          '-c',
          `sandbox_mode="${options.permissionMode}"`,
          String(options.resumeThreadId),
          options.prompt
        ]
      : [
          cli.entry,
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-C',
          options.workspace,
          '-s',
          options.permissionMode,
          ...runtime.overrides.flatMap((override) => ['-c', override]),
          options.prompt
        ]

    if (resuming) {
      options.onEvent({
        type: 'notice',
        level: 'info',
        message: `续接上一轮上下文（thread ${String(options.resumeThreadId).slice(0, 8)}…）`
      })
    }

    this.cancelled = false
    const child = spawn(cli.nodePath, args, {
      cwd: options.workspace,
      env: {
        ...process.env,
        // Electron 里 nodePath 是 electron.exe：不加这个会启动一整套 Chromium，
        // 与父进程抢 userData/Cache 后立刻退出（退出码 -1、stderr 为空）
        ...codexChildNodeEnv(cli),
        ...runtime.env,
        CODEX_HOME: runtime.codexHome,
        // 避免 codex 试图读终端
        TERM: 'dumb'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    const splitter = createLineSplitter((line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        options.onEvent({ type: 'stderr', text: line })
        return
      }
      const event = mapExecEvent(parsed)
      if (event) {
        // 记住 thread id：下一轮要用它做 `codex exec resume` 才能续接上下文
        if (event.type === 'thread.started') this.threadId = event.threadId
        options.onEvent(event)
      }
    })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk))

    const stderrSplitter = createLineSplitter((line) => {
      if (STDERR_NOISE.some((re) => re.test(line))) return
      options.onEvent({ type: 'stderr', text: line })
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderrSplitter.push(chunk))

    await new Promise<void>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve()
      }

      child.on('error', (error) => {
        options.onEvent({ type: 'error', message: `启动 codex 失败：${error.message}`, fatal: true })
        options.onEvent({ type: 'exit', code: null, signal: null })
        this.child = null
        settle()
      })

      child.on('close', (code, signal) => {
        splitter.flush()
        stderrSplitter.flush()
        options.onEvent({ type: 'turn.ended', threadId: this.threadId })
        options.onEvent({ type: 'exit', code, signal: signal ?? null })
        this.child = null
        settle()
      })
    })
  }

  /** 结束子进程（Windows 上要连子孙进程一起杀，否则 powershell 会残留） */
  cancel(): void {
    this.cancelled = true
    const child = this.child
    if (!child || !child.pid) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        return
      } catch {
        /* 退化为普通 kill */
      }
    }
    child.kill('SIGTERM')
  }

  get wasCancelled(): boolean {
    return this.cancelled
  }
}
