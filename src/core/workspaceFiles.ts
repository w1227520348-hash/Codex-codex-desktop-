/**
 * 工作区文件枚举，供侧栏文件树使用。
 *
 * 三条硬约束，否则一个稍大的仓库就能把界面拖垮：
 *   - 只遍历有限层数（默认 4 层）；
 *   - 跳过依赖/构建/缓存类重目录（node_modules、.git、dist…）；
 *   - 总条目数封顶，超出即停止并在结果上标记 truncated。
 *
 * 输出是**前序**扁平列表（父目录紧跟其子项），渲染层照着建树即可，顺序稳定可断言。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { WorkspaceEntry } from '../shared/types'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.bzr',
  'dist', 'out', 'build', 'release', '.next', '.nuxt', '.output', '.vercel', '.netlify',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  'target', 'vendor', 'bower_components', '.gradle', '.idea', '.cache', '.parcel-cache',
  'coverage', '.turbo', '.pnpm-store', '.yarn', '.dart_tool', 'Pods', '.stack-work'
])

export interface ListOptions {
  maxDepth?: number
  maxEntries?: number
}

export interface ListResult {
  entries: WorkspaceEntry[]
  truncated: boolean
  /** 已遍历但被跳过的重目录名（用于向用户解释） */
  skippedDirs: string[]
}

export const DEFAULT_MAX_DEPTH = 4
export const DEFAULT_MAX_ENTRIES = 2000

export function listWorkspaceFilesResult(root: string, options: ListOptions = {}): ListResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const entries: WorkspaceEntry[] = []
  const skippedDirs = new Set<string>()
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return

    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    // 目录优先、同类按名字排，保证输出稳定
    const sorted = [...dirents].sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1
      const bDir = b.isDirectory() ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })

    for (const dirent of sorted) {
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      const full = path.join(dir, dirent.name)
      const rel = path.relative(root, full).split(path.sep).join('/')

      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) {
          skippedDirs.add(dirent.name)
          continue
        }
        entries.push({ path: full, rel, name: dirent.name, isDir: true, size: 0 })
        walk(full, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        /* 读不到 stat 就按 0 处理，不用因此漏掉文件 */
      }
      entries.push({ path: full, rel, name: dirent.name, isDir: false, size })
    }
  }

  walk(path.resolve(root), 1)
  return { entries, truncated, skippedDirs: [...skippedDirs] }
}

export function listWorkspaceFiles(root: string, options: ListOptions = {}): WorkspaceEntry[] {
  return listWorkspaceFilesResult(root, options).entries
}
