import type { ReactNode } from 'react'

/**
 * 极简 Markdown 渲染器（输出 React 元素，绝不使用 dangerouslySetInnerHTML）。
 *
 * 支持：围栏代码块、行内代码、**粗体**、*斜体*、# ~ ### 标题、无序/有序列表、
 * 引用、分隔线、裸 URL 自动转链接（target="_blank" rel="noreferrer"）。
 *
 * 设计取舍：刻意不做完整 CommonMark 实现（不引依赖），未识别的语法按纯文本输出。
 */

export interface ParsedCodeBlock {
  kind: 'code'
  lang: string
  code: string
}

export interface ParsedListBlock {
  kind: 'list'
  ordered: boolean
  items: ParsedListItem[]
}

export interface ParsedListItem {
  marker: string
  content: string
}

export interface ParsedQuoteBlock {
  kind: 'quote'
  lines: string[]
}

export interface ParsedHeadingBlock {
  kind: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
}

export interface ParsedParagraphBlock {
  kind: 'paragraph'
  text: string
}

export interface ParsedDividerBlock {
  kind: 'divider'
}

export type ParsedBlock =
  | ParsedCodeBlock
  | ParsedListBlock
  | ParsedQuoteBlock
  | ParsedHeadingBlock
  | ParsedParagraphBlock
  | ParsedDividerBlock

/* ------------------------------------------------------------------ *
 * 块级解析
 * ------------------------------------------------------------------ */

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/
const UL_RE = /^(\s*)([-*+])\s+(.*)$/
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const DIVIDER_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

export function parseMarkdown(source: string): ParsedBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ParsedBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index += 1
      continue
    }

    // 围栏代码块
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const lang = (fence[2] ?? '').trim()
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const closing = FENCE_RE.exec(current)
        const closingMarker = closing?.[1] ?? ''
        if (closing && closingMarker[0] === marker[0] && closingMarker.length >= marker.length) {
          index += 1
          break
        }
        body.push(current)
        index += 1
      }
      blocks.push({ kind: 'code', lang, code: body.join('\n') })
      continue
    }

    // 标题
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const hashes = heading[1] ?? '#'
      const level = Math.min(Math.max(hashes.length, 1), 6)
      blocks.push({
        kind: 'heading',
        level: level as 1 | 2 | 3 | 4 | 5 | 6,
        text: (heading[2] ?? '').trim()
      })
      index += 1
      continue
    }

    // 分隔线
    if (DIVIDER_RE.test(line)) {
      blocks.push({ kind: 'divider' })
      index += 1
      continue
    }

    // 引用
    if (QUOTE_RE.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const matched = QUOTE_RE.exec(lines[index] ?? '')
        if (!matched) break
        quoteLines.push(matched[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', lines: quoteLines })
      continue
    }

    // 列表（无序 / 有序）
    const firstUl = UL_RE.exec(line)
    const firstOl = OL_RE.exec(line)
    if (firstUl || firstOl) {
      const ordered = Boolean(firstOl)
      const items: ParsedListItem[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const ul = UL_RE.exec(current)
        const ol = OL_RE.exec(current)
        if (ordered && ol) {
          items.push({ marker: `${ol[2] ?? '1'}.`, content: (ol[3] ?? '').trim() })
          index += 1
          continue
        }
        if (!ordered && ul) {
          items.push({ marker: '•', content: (ul[3] ?? '').trim() })
          index += 1
          continue
        }
        // 续行：缩进的非空行并入上一条
        if (items.length > 0 && /^\s+\S/.test(current)) {
          const last = items[items.length - 1]
          if (last) last.content = `${last.content} ${current.trim()}`
          index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // 段落：吃到空行、围栏、标题、引用或列表起始为止
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '') break
      if (FENCE_RE.test(current) || HEADING_RE.test(current) || DIVIDER_RE.test(current)) break
      if (QUOTE_RE.test(current)) break
      if (UL_RE.test(current) || OL_RE.test(current)) break
      paragraph.push(current.trim())
      index += 1
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    } else {
      index += 1
    }
  }

  return blocks
}

/* ------------------------------------------------------------------ *
 * 行内解析
 * ------------------------------------------------------------------ */

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\[[^\]\n]*\]\([^()\s]*\))|(\*[^*\n]+\*)/
const SAFE_PROTOCOLS = ['http://', 'https://', 'mailto:']

/** 只允许安全协议，返回 null 表示按纯文本渲染 */
export function safeHref(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null
  const lower = value.toLowerCase()
  if (SAFE_PROTOCOLS.some((protocol) => lower.startsWith(protocol))) return value
  // 站内相对路径也放行
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('#')) return value
  return null
}

/** 依次切分：裸 URL / 行内代码 / 粗体 / 链接 / 斜体，其余为纯文本 */
export function parseInline(text: string): ReactNode[] {
  return renderInline(text, 0)
}

function renderInline(text: string, depth: number): ReactNode[] {
  if (text === '') return []

  const nodes: ReactNode[] = []
  let cursor = 0
  let keySeed = 0

  while (cursor < text.length) {
    URL_RE.lastIndex = cursor
    const urlMatch = URL_RE.exec(text)
    const rest = text.slice(cursor)
    const inlineMatch = INLINE_RE.exec(rest)

    const urlAt = urlMatch ? urlMatch.index : Number.POSITIVE_INFINITY
    const inlineAt = inlineMatch ? inlineMatch.index : Number.POSITIVE_INFINITY

    if (urlAt === Number.POSITIVE_INFINITY && inlineAt === Number.POSITIVE_INFINITY) {
      nodes.push(text.slice(cursor))
      break
    }

    if (inlineMatch && inlineAt <= urlAt) {
      if (inlineMatch.index > 0) nodes.push(rest.slice(0, inlineMatch.index))
      const raw = inlineMatch[0]
      const start = cursor + inlineMatch.index
      cursor = start + raw.length
      nodes.push(renderInlineToken(raw, `${start}-${keySeed}`, depth + 1))
      keySeed += 1
      continue
    }

    if (urlMatch) {
      if (urlAt > cursor) nodes.push(text.slice(cursor, urlAt))
      const href = safeHref(urlMatch[0])
      if (href) {
        nodes.push(
          <a key={`u-${urlAt}-${keySeed}`} href={href} target="_blank" rel="noreferrer">
            {urlMatch[0]}
          </a>
        )
      } else {
        nodes.push(urlMatch[0])
      }
      cursor = urlAt + urlMatch[0].length
      keySeed += 1
      continue
    }

    nodes.push(text.slice(cursor))
    break
  }

  return nodes.filter((node) => node !== '')
}

function renderInlineToken(raw: string, key: string, depth: number): ReactNode {
  if (raw.startsWith('`') && raw.endsWith('`') && raw.length > 2) {
    return (
      <code key={`c-${key}`} className="md-inline-code">
        {raw.slice(1, -1)}
      </code>
    )
  }

  if ((raw.startsWith('**') && raw.endsWith('**')) || (raw.startsWith('__') && raw.endsWith('__'))) {
    const inner = raw.slice(2, -2)
    return <strong key={`b-${key}`}>{depth > 6 ? inner : renderInline(inner, depth)}</strong>
  }

  if (raw.startsWith('[') && raw.includes('](') && raw.endsWith(')')) {
    const splitAt = raw.indexOf('](')
    const label = raw.slice(1, splitAt)
    const href = safeHref(raw.slice(splitAt + 2, -1))
    if (href) {
      return (
        <a key={`l-${key}`} href={href} target="_blank" rel="noreferrer">
          {depth > 6 ? label : renderInline(label, depth)}
        </a>
      )
    }
    return <span key={`l-${key}`}>{label}</span>
  }

  if (raw.startsWith('*') && raw.endsWith('*') && raw.length > 2) {
    const inner = raw.slice(1, -1)
    return <em key={`i-${key}`}>{depth > 6 ? inner : renderInline(inner, depth)}</em>
  }

  return <span key={`t-${key}`}>{raw}</span>
}
