import { memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import { countFileChanges, fileKindFromDiff, parseUnifiedDiff } from '@renderer/utils/diff'
import type { DiffFile, DiffLine } from '@renderer/utils/diff'

export interface DiffPanelProps {
  text: string | null
  label: string | null
  loading: boolean
  workspace: string | null
  onRefresh: () => void
}

/** 右侧「Diff 预览」标签页：自己解析统一 diff，逐行渲染并加行号 */
function DiffPanelImpl({ text, label, loading, workspace, onRefresh }: DiffPanelProps): ReactNode {
  const parsed = useMemo(() => (text === null ? null : parseUnifiedDiff(text)), [text])

  if (loading) {
    return <div className="panel-empty">正在读取 diff…</div>
  }

  if (!text || !parsed) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-title">还没有 diff 可以预览</div>
        <p>在对话区点击工具卡片上的「查看 diff」，或在审批卡片上查看补丁。</p>
        {workspace ? <p className="panel-empty-hint">当前工作区：{workspace}</p> : null}
      </div>
    )
  }

  if (parsed.files.length === 0) {
    return (
      <div className="diff-panel">
        <div className="diff-toolbar">
          <span className="diff-toolbar-title">{label ?? 'diff'}</span>
          <button type="button" className="button button-ghost button-sm" onClick={onRefresh}>
            刷新
          </button>
        </div>
        <div className="panel-empty">这个路径没有可解析的 diff，下面是原始输出：</div>
        <pre className="command-output diff-raw">
          <code>{parsed.fallback}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="diff-panel">
      <div className="diff-toolbar">
        <span className="diff-toolbar-title">{label ?? '统一 diff'}</span>
        <span className="diff-stat diff-stat-add">+{parsed.additions}</span>
        <span className="diff-stat diff-stat-del">-{parsed.deletions}</span>
        <span className="diff-toolbar-files">{parsed.files.length} 个文件</span>
        <button type="button" className="button button-ghost button-sm" onClick={onRefresh}>
          刷新
        </button>
      </div>

      <div className="diff-scroll">
        {parsed.files.map((file, index) => (
          <FileDiff key={`${file.path}-${index}`} file={file} defaultOpen />
        ))}
      </div>
    </div>
  )
}

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const stats = countFileChanges(file)
  const kind = fileKindFromDiff(file)

  return (
    <section className="diff-file">
      <button type="button" className="diff-file-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={['diff-file-caret', open ? 'diff-file-caret-open' : ''].join(' ')} aria-hidden="true">
          ▶
        </span>
        <span className="diff-file-path" title={file.path}>
          {file.path === '' ? '(未知文件)' : file.path}
        </span>
        <Badge tone={kind === 'add' ? 'success' : kind === 'delete' ? 'danger' : 'info'}>
          {kind === 'add' ? '新增' : kind === 'delete' ? '删除' : '修改'}
        </Badge>
        <span className="diff-stat diff-stat-add">+{stats.additions}</span>
        <span className="diff-stat diff-stat-del">-{stats.deletions}</span>
      </button>

      {open ? (
        <div className="diff-body">
          {file.hunks.length === 0 ? <div className="panel-empty">该文件没有文本差异（可能是二进制或仅权限变化）</div> : null}
          {file.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
              <div className="diff-hunk-head">{hunk.header}</div>
              <table className="diff-table">
                <tbody>
                  {hunk.lines.map((line, lineIndex) => (
                    <DiffRow key={`${hunkIndex}-${lineIndex}`} line={line} />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function DiffRow({ line }: { line: DiffLine }): ReactNode {
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'context' ? ' ' : ''

  return (
    <tr className={`diff-row diff-row-${line.kind}`}>
      <td className="diff-no">{line.oldNo ?? ''}</td>
      <td className="diff-no">{line.newNo ?? ''}</td>
      <td className="diff-sign">{marker}</td>
      <td className="diff-code">{line.text === '' ? '\u00a0' : line.text}</td>
    </tr>
  )
}

const DiffPanel = memo(DiffPanelImpl)
export default DiffPanel
