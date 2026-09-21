/**
 * 统一 diff 文本解析（不引依赖）。
 * 支持 git 风格：diff --git / --- +++ / @@ hunk / +/-/空格 行 / \ No newline。
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta' | 'hunk' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 旧文件行号，元信息行没有 */
  oldNo: number | null
  /** 新文件行号，元信息行没有 */
  newNo: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffFile {
  /** 首选路径（git 头优先，其次 +++/---） */
  path: string
  oldPath?: string
  newPath?: string
  headers: string[]
  hunks: DiffHunk[]
}

export interface ParsedDiff {
  files: DiffFile[]
  /** 文本里没有 diff 标记时的原始文本（此时 files 为空） */
  fallback: string
  additions: number
  deletions: number
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function stripPrefix(value: string): string {
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2)
  return value
}

function normalizePathToken(raw: string): string {
  const token = raw.trim().split('\t')[0] ?? ''
  if (token === '/dev/null') return token
  return stripPrefix(token)
}

/** 判断一个路径的新增/修改/删除类型（用于徽章） */
export function fileKindFromDiff(file: DiffFile): 'add' | 'delete' | 'update' {
  if (file.oldPath === '/dev/null') return 'add'
  if (file.newPath === '/dev/null') return 'delete'
  return 'update'
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const normalized = text.replace(/\r\n?/g, '\n')
  const rawLines = normalized.split('\n')
  const hasDiffMarker = rawLines.some((line) => line.startsWith('diff --git') || line.startsWith('@@'))

  if (!hasDiffMarker) {
    return { files: [], fallback: normalized, additions: 0, deletions: 0 }
  }

  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let additions = 0
  let deletions = 0

  const ensureFile = (): DiffFile => {
    if (!current) {
      current = { path: '', headers: [], hunks: [] }
      files.push(current)
    }
    return current
  }

  for (const line of rawLines) {
    if (line.startsWith('diff --git ')) {
      current = { path: '', headers: [line], hunks: [] }
      files.push(current)
      hunk = null
      continue
    }

    if (line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity index') || line.startsWith('rename ')) {
      ensureFile().headers.push(line)
      continue
    }

    if (line.startsWith('--- ')) {
      const file = ensureFile()
      file.oldPath = normalizePathToken(line.slice(4))
      file.headers.push(line)
      continue
    }

    if (line.startsWith('+++ ')) {
      const file = ensureFile()
      file.newPath = normalizePathToken(line.slice(4))
      file.headers.push(line)
      if (!file.path) {
        const candidate = file.newPath !== '/dev/null' ? file.newPath : (file.oldPath ?? '')
        file.path = candidate
      }
      continue
    }

    const hunkMatch = HUNK_RE.exec(line)
    if (hunkMatch) {
      const file = ensureFile()
      oldNo = Number(hunkMatch[1] ?? 0)
      newNo = Number(hunkMatch[2] ?? 0)
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] }
      file.hunks.push(hunk)
      continue
    }

    if (!hunk) {
      // 头部的杂项（例如 "Binary files ... differ"）
      if (current && line.trim() !== '') current.headers.push(line)
      continue
    }

    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'note', text: line, oldNo: null, newNo: null })
      continue
    }

    const marker = line.charAt(0)
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo })
      newNo += 1
      additions += 1
      continue
    }
    if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null })
      oldNo += 1
      deletions += 1
      continue
    }
    if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo, newNo })
      oldNo += 1
      newNo += 1
      continue
    }
    if (line === '') {
      // 尾随空行，忽略
      continue
    }
    hunk.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
  }

  return { files, fallback: '', additions, deletions }
}

/** 一个文件里的 +/- 统计 */
export function countFileChanges(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1
      else if (line.kind === 'del') deletions += 1
    }
  }
  return { additions, deletions }
}

/** 从 patch 文本猜一个文件名，用于审批卡片展示 */
export function guessPathFromPatch(patch: string): string[] {
  const paths: string[] = []
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const value = normalizePathToken(line.slice(4))
      if (value && value !== '/dev/null' && !paths.includes(value)) paths.push(value)
    }
  }
  return paths
}
