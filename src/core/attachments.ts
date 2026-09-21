/**
 * 附件：把用户挑的文件变成 Codex 能真正读到的东西。
 *
 * 关键约束（决定了这里为什么这么写）：
 *  1. codex 只认它自己的工具（shell / apply_patch…），我们**没法**给它塞一个自定义工具去读文件。
 *     所以「让模型理解文件内容」的可靠办法是两条腿：
 *       a. 小文本文件直接把正文内联进提示词（模型不用调工具就看得到）；
 *       b. 大文件/二进制只给路径，并明确指示模型用它的命令工具去读。
 *  2. 工作区外的文件如果只给原始路径，可能撞上沙箱策略；而且用户也不希望我们把文件
 *     摊进他们的仓库。所以外部文件统一拷贝到 `<APP_DIR>/attachments/<sessionId>/`，
 *     给模型的绝对路径指向副本。工作区内的文件则原地引用，不复制。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR } from './settings'
import type { AddAttachmentsResult, AttachmentKind, AttachmentRef } from '../shared/types'

/** 单文件上限：超过就拒绝，避免把 GB 级文件搬来搬去 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024
/** 单个文本文件内联进提示词的字符上限 */
export const INLINE_PER_FILE_CHARS = 40_000
/** 所有附件内联字符总量上限（防止一次塞爆上下文） */
export const INLINE_TOTAL_CHARS = 120_000
/**
 * 剩余预算少于这个数时就不内联了 —— 否则会出现「内联了 3 个字符」这种既没用、
 * 又让模型以为这就是全文的情况。特例：整个文件本来就塞得进剩余预算，那还是内联。
 */
export const MIN_INLINE_CHARS = 500
/** 判断「是不是文本」时最多嗅探多少字节 */
const SNIFF_BYTES = 8192

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'm', 'mm',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'env', 'properties',
  'gitignore', 'dockerignore', 'editorconfig', 'lock', 'patch', 'diff', 'tex', 'srt', 'vtt'
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tiff'])

export function attachmentsDir(sessionId: string | null): string {
  return path.join(APP_DIR, 'attachments', sessionId && sessionId.trim() !== '' ? sessionId : 'adhoc')
}

/** 附件 id：同一路径稳定，重复添加可去重 */
function idFor(resolvedPath: string): string {
  return crypto.createHash('sha1').update(resolvedPath.toLowerCase()).digest('hex').slice(0, 12)
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 把文件名里不能用于路径的字符换掉，并保留扩展名 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 80)
  return cleaned.length === 0 ? 'file' : cleaned
}

/** 纯扩展名判断（快路径） */
export function kindByExtension(name: string): AttachmentKind | null {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase()
  if (ext === '') return null
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return null
}

/**
 * 判断文件是文本还是二进制。
 * 扩展名不认识时看内容：含 NUL 字节基本就是二进制（这是 git 用的同一招）。
 */
export function sniffKind(name: string, buffer: Buffer): AttachmentKind {
  const byExt = kindByExtension(name)
  if (byExt === 'text' || byExt === 'image') return byExt
  const sample = buffer.subarray(0, Math.min(buffer.length, SNIFF_BYTES))
  for (const byte of sample) {
    if (byte === 0) return 'binary'
  }
  return 'text'
}

/**
 * 行数：按「换行符个数」算，末尾的换行不再多算一行。
 * 这样 "a\n" 是 1 行（和 wc -l 一致），而不是 2 行 —— 展示给用户的数字不能吓人。
 */
export function countLines(text: string): number {
  if (text === '') return 0
  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines += 1
  }
  return text.endsWith('\n') ? newlines : newlines + 1
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export interface PrepareOptions {
  /** 工作区：其内部的文件原地引用，不拷贝 */
  workspace?: string | null
  /** 内联字符总量上限，默认 INLINE_TOTAL_CHARS */
  inlineTotalChars?: number
}

/**
 * 登记附件：校验 → 必要时拷贝 → 探测类型 → 读可内联的正文。
 * 不做任何 UI 决定，返回的结构渲染层与编排层共用。
 */
export function prepareAttachments(
  rawPaths: string[],
  sessionId: string | null,
  options: PrepareOptions = {}
): AddAttachmentsResult {
  const workspace = options.workspace ? path.resolve(options.workspace) : null
  const totalBudget = options.inlineTotalChars ?? INLINE_TOTAL_CHARS
  const attachments: AttachmentRef[] = []
  const errors: { path: string; reason: string }[] = []
  const seen = new Set<string>()
  let usedBudget = 0

  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const resolved = path.resolve(raw.trim())

    const id = idFor(resolved)
    if (seen.has(id)) continue
    seen.add(id)

    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch {
      errors.push({ path: resolved, reason: '文件不存在或不可读' })
      continue
    }
    if (stat.isDirectory()) {
      errors.push({ path: resolved, reason: '暂不支持直接提交文件夹，请选择其中的文件' })
      continue
    }
    if (!stat.isFile()) {
      errors.push({ path: resolved, reason: '不是普通文件' })
      continue
    }
    if (stat.size > MAX_FILE_BYTES) {
      errors.push({ path: resolved, reason: `文件过大（${formatBytes(stat.size)}，上限 ${formatBytes(MAX_FILE_BYTES)}）` })
      continue
    }

    const name = path.basename(resolved)
    // 工作区内的文件原地引用；工作区外的拷一份进应用数据目录
    const inWorkspace = workspace !== null && isInside(resolved, workspace)
    let target = resolved
    let copied = false
    if (!inWorkspace) {
      try {
        const dir = attachmentsDir(sessionId)
        fs.mkdirSync(dir, { recursive: true })
        target = path.join(dir, `${attachments.length + 1}-${safeFileName(name)}`)
        fs.copyFileSync(resolved, target)
        copied = true
      } catch (error) {
        errors.push({ path: resolved, reason: `拷贝失败：${error instanceof Error ? error.message : String(error)}` })
        continue
      }
    }

    let buffer: Buffer = Buffer.alloc(0)
    try {
      buffer = fs.readFileSync(target)
    } catch {
      /* 读不到就当二进制处理，只给路径 */
    }

    const kind = sniffKind(name, buffer)
    let inlined = false
    let inlineChars = 0
    let lines: number | null = null
    let note: string | undefined

    if (kind === 'text') {
      const full = buffer.toString('utf8')
      const totalLines = countLines(full)
      lines = totalLines
      const remaining = totalBudget - usedBudget
      if (remaining <= 0 || (remaining < MIN_INLINE_CHARS && full.length > remaining)) {
        // 预算不够：宁可不内联（并说清楚），也不要塞半截正文让模型误以为看全了
        note = `本轮内联预算已用完（共 ${totalBudget} 字符），本文件未内联，请用工具读取`
      } else {
        const budget = Math.min(INLINE_PER_FILE_CHARS, remaining)
        const slice = full.length > budget ? full.slice(0, budget) : full
        inlined = true
        inlineChars = slice.length
        usedBudget += slice.length
        if (slice.length < full.length) {
          note = `仅内联前 ${slice.length} 字符（全文 ${full.length} 字符 / ${totalLines} 行），其余请用工具读取`
        }
      }
    } else if (kind === 'image') {
      note = '图片：DeepSeek 文本模型看不到像素。可让 Codex 用工具检查该文件，或自行描述图片内容'
    } else {
      note = '二进制文件，未内联，请用工具按需读取'
    }

    attachments.push({
      id,
      name,
      sourcePath: resolved,
      path: target,
      kind,
      size: stat.size,
      copied,
      inlined,
      inlineChars,
      lines,
      note,
      addedAt: Date.now()
    })
  }

  return { attachments, errors }
}

/** 读出已登记附件的正文（用于拼提示词；只取内联预算内的部分） */
export function readInlineText(attachment: AttachmentRef): string {
  if (!attachment.inlined) return ''
  try {
    const full = fs.readFileSync(attachment.path, 'utf8')
    return full.slice(0, attachment.inlineChars)
  } catch {
    return ''
  }
}

/** 拼「怎么读这个文件」的提示；非文本文件给现成的命令例子 */
function readHint(attachment: AttachmentRef): string {
  if (attachment.kind === 'text') {
    // Windows PowerShell 的 Get-Content 默认按 ANSI 读，UTF-8 文件会整片乱码，
    // 所以把 -Encoding UTF8 直接写进示例里（实测不加会读成乱码，连标记都会被吃掉）。
    return [
      `    读取示例：Get-Content -TotalCount 200 -Encoding UTF8 "${attachment.path}"`,
      `    全文检索：Select-String -Path "${attachment.path}" -Pattern "关键词" -Encoding UTF8`
    ].join('\n')
  }
  return `    可用工具检查该文件（例如按类型解析/统计），不要凭空猜测内容。`
}

export interface PromptAttachment {
  attachment: AttachmentRef
  /** 已读出的正文（可能为空） */
  text: string
}

/**
 * 把用户输入 + 附件拼成真正发给 codex 的一轮输入。
 * 没有附件时原样返回，保证既有行为完全不变。
 */
export function buildAttachmentPrompt(
  userPrompt: string,
  items: PromptAttachment[]
): string {
  const usable = items.filter((item) => item.attachment !== undefined)
  if (usable.length === 0) return userPrompt

  const manifest: string[] = []
  const bodies: string[] = []

  usable.forEach((item, index) => {
    const a = item.attachment
    const lines: string[] = []
    lines.push(`${index + 1}. ${a.name} — ${a.kind === 'text' ? '文本' : a.kind === 'image' ? '图片' : '二进制'}，${formatBytes(a.size)}${a.lines !== null ? `，${a.lines} 行` : ''}`)
    lines.push(`   路径：${a.path}`)
    if (a.sourcePath !== a.path) lines.push(`   原始位置：${a.sourcePath}`)
    if (a.inlined) {
      lines.push(`   正文已内联在本消息末尾（${a.inlineChars} 字符）`)
    } else {
      lines.push(`   正文未内联${a.note ? `（${a.note}）` : ''}，请用你的工具读取：`)
      lines.push(readHint(a))
    }
    manifest.push(lines.join('\n'))

    if (a.inlined && item.text !== '') {
      // 极端情况下正文里可能自带分隔符，先打散，避免和我们的标记混淆。
      // 注意 <<< 与 END FILE 之间通常有空格，正则必须容忍它。
      const safe = item.text.replace(/<<<(\s*\/?\s*)(END\s+FILE|FILE)\b/g, '< <<$1$2')
      bodies.push(`<<< FILE ${index + 1}: ${a.name} >>>\n${safe}\n<<< END FILE ${index + 1}: ${a.name} >>>`)
    }
  })

  const parts: string[] = [userPrompt.trim()]
  parts.push('────────────────────────────────')
  parts.push(`【本轮随消息提交了 ${usable.length} 个文件】`)
  parts.push(manifest.join('\n\n'))
  if (bodies.length > 0) {
    parts.push('【文件正文】')
    parts.push(bodies.join('\n\n'))
  }
  parts.push(
    '请先据此了解文件内容，再完成上面的请求；未内联的文件必须用你的工具按给出的路径读取，不要凭空猜测文件内容。'
  )
  return parts.join('\n\n')
}

/** 会话删除时清掉它的附件副本 */
export function cleanupSessionAttachments(sessionId: string): void {
  try {
    fs.rmSync(attachmentsDir(sessionId), { recursive: true, force: true })
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 删掉单个附件拷贝（原地引用的文件绝不动） */
export function removeAttachmentCopy(attachment: AttachmentRef): boolean {
  if (!attachment.copied) return true
  try {
    if (fs.existsSync(attachment.path)) fs.rmSync(attachment.path, { force: true })
    return true
  } catch {
    return false
  }
}
