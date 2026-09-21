import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import { parseInline, parseMarkdown } from '@renderer/utils/markdown'
import type { ParsedBlock } from '@renderer/utils/markdown'

export interface MarkdownProps {
  source: string
  streaming?: boolean
  className?: string
}

/**
 * 极简 Markdown → React 元素。无 innerHTML，无新依赖。
 */
function MarkdownImpl({ source, streaming = false, className }: MarkdownProps): ReactNode {
  const blocks = useMemo(() => parseMarkdown(source), [source])

  const classes = ['md', className].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      {blocks.map((block, index) => renderBlock(block, index, blocks.length, streaming))}
      {streaming ? <span className="md-caret" aria-hidden="true" /> : null}
    </div>
  )
}

function renderBlock(block: ParsedBlock, index: number, total: number, streaming: boolean): ReactNode {
  const key = `${block.kind}-${index}`
  const isLast = index === total - 1

  switch (block.kind) {
    case 'code':
      return (
        <div className="md-code" key={key}>
          <div className="md-code-head">
            <span className="md-code-lang">{block.lang === '' ? 'text' : block.lang}</span>
          </div>
          <pre className="md-code-body">
            <code data-ctx="code" data-ctx-text={block.code}>
              {block.code}
            </code>
          </pre>
        </div>
      )

    case 'heading': {
      const { level, text } = block
      const content = parseInline(text)
      switch (level) {
        case 1:
          return (
            <h1 className="md-heading md-h1" key={key}>
              {content}
            </h1>
          )
        case 2:
          return (
            <h2 className="md-heading md-h2" key={key}>
              {content}
            </h2>
          )
        case 3:
          return (
            <h3 className="md-heading md-h3" key={key}>
              {content}
            </h3>
          )
        case 4:
          return (
            <h4 className="md-heading md-h4" key={key}>
              {content}
            </h4>
          )
        case 5:
          return (
            <h5 className="md-heading md-h5" key={key}>
              {content}
            </h5>
          )
        default:
          return (
            <h6 className="md-heading md-h6" key={key}>
              {content}
            </h6>
          )
      }
    }

    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li className="md-list-item" key={`${key}-${itemIndex}`}>
          {block.ordered ? <span className="md-list-marker">{item.marker}</span> : null}
          <span className="md-list-content">{parseInline(item.content)}</span>
        </li>
      ))
      if (block.ordered) {
        return (
          <ol className="md-list" key={key}>
            {items}
          </ol>
        )
      }
      return (
        <ul className="md-list" key={key}>
          {items}
        </ul>
      )
    }

    case 'quote':
      return (
        <blockquote className="md-quote" key={key}>
          {block.lines.map((line, lineIndex) => (
            <p className="md-quote-line" key={`${key}-${lineIndex}`}>
              {parseInline(line)}
            </p>
          ))}
        </blockquote>
      )

    case 'divider':
      return <hr className="md-divider" key={key} />

    case 'paragraph': {
      const showCaret = streaming && isLast
      return (
        <p className="md-paragraph" key={key}>
          {parseInline(block.text)}
          {showCaret ? <span className="md-caret" aria-hidden="true" /> : null}
        </p>
      )
    }

    default:
      return null
  }
}

const Markdown = memo(MarkdownImpl)
export default Markdown
