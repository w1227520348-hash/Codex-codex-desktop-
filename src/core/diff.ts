/**
 * 文件改动预览（需求 5）：优先用 git 生成统一 diff；不是 git 仓库时给出可读的降级说明。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function git(workspace: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', workspace, ...args], {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' }
  }
}

export async function isGitRepo(workspace: string): Promise<boolean> {
  const result = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  return result.ok && result.stdout.trim() === 'true'
}

function statusKind(code: string): string {
  if (code === '??') return 'untracked'
  if (code.includes('A')) return 'add'
  if (code.includes('D')) return 'delete'
  if (code.includes('R')) return 'rename'
  if (code.includes('M')) return 'update'
  return 'update'
}

/** 列出工作区当前改动，用于 Diff 面板的文件树 */
export async function listChanges(workspace: string): Promise<{ path: string; kind: string }[]> {
  if (!(await isGitRepo(workspace))) return []
  const result = await git(workspace, ['status', '--porcelain'])
  if (!result.ok) return []
  const entries: { path: string; kind: string }[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length < 4) continue
    const code = line.slice(0, 2)
    let filePath = line.slice(3).trim()
    // 重命名形式 "old -> new"
    const arrow = filePath.indexOf(' -> ')
    if (arrow >= 0) filePath = filePath.slice(arrow + 4)
    filePath = filePath.replace(/^"|"$/g, '')
    if (filePath.length === 0) continue
    entries.push({ path: filePath, kind: statusKind(code) })
  }
  return entries
}

function synthesizeNewFileDiff(workspace: string, relativePath: string): string {
  try {
    const absolute = path.join(workspace, relativePath)
    const content = fs.readFileSync(absolute, 'utf8')
    const lines = content.split(/\r?\n/)
    const header = [
      `diff --git a/${relativePath} b/${relativePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relativePath}`,
      `@@ -0,0 +1,${lines.length} @@`
    ]
    return [...header, ...lines.map((l) => `+${l}`)].join('\n')
  } catch (error) {
    return `无法读取新增文件 ${relativePath}：${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 取指定路径的统一 diff。paths 为空时取全部改动。
 */
export async function getDiff(workspace: string, paths: string[]): Promise<string> {
  if (!fs.existsSync(workspace)) return `工作目录不存在：${workspace}`
  if (!(await isGitRepo(workspace))) {
    return [
      `工作目录不是 Git 仓库，无法生成统一 diff：`,
      workspace,
      '',
      '建议：在该目录执行 `git init` 后即可查看完整 diff 视图。',
      '（Codex 的改动已经直接写入磁盘，可以正常使用，只是缺少逐行对比视图。）'
    ].join('\n')
  }

  const sections: string[] = []
  const targets = paths.filter((p) => p.trim().length > 0)

  // 已跟踪文件的改动（含已暂存）：对比 HEAD
  const trackedArgs = ['diff', '--no-color', '--no-ext-diff', 'HEAD']
  if (targets.length > 0) trackedArgs.push('--', ...targets)
  const tracked = await git(workspace, trackedArgs)
  if (tracked.ok && tracked.stdout.trim().length > 0) sections.push(tracked.stdout.trimEnd())

  // 未跟踪的新文件：git diff 不会显示，这里自己合成
  const changes = await listChanges(workspace)
  const untracked = changes
    .filter((c) => c.kind === 'untracked')
    .filter((c) => targets.length === 0 || targets.includes(c.path))
  for (const entry of untracked) {
    sections.push(synthesizeNewFileDiff(workspace, entry.path))
  }

  if (sections.length === 0) {
    return targets.length > 0
      ? `没有检测到这些路径的改动：\n${targets.join('\n')}\n\n（可能改动已被提交，或路径写法与 git 不一致）`
      : '当前工作区没有未提交的改动。'
  }
  return sections.join('\n\n')
}
