import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconAttach,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconRefresh
} from '@renderer/components/icons'
import { Spinner } from '@renderer/components/Spinner'
import { formatBytes } from '@renderer/utils/format'
import type { WorkspaceEntry } from '@shared/types'

export interface WorkspaceFilesProps {
  workspace: string | null
  /** 把文件交给 Codex（塞进输入框的附件列表） */
  onAttach: (paths: string[]) => void
}

/** 一次最多画多少行：仓库再大也不能把界面卡死 */
const MAX_RENDER_ROWS = 600

/**
 * 侧栏「工作区文件」。
 * 点击文件 = 交给 Codex 理解；右键还有复制路径、在资源管理器中显示等。
 */
function WorkspaceFilesImpl({ workspace, onAttach }: WorkspaceFilesProps): ReactNode {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [skipped, setSkipped] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    if (!workspace) {
      setEntries([])
      return
    }
    setLoading(true)
    setError(null)
    void window.api
      .listWorkspaceFiles(workspace)
      .then((result) => {
        setEntries(result.entries)
        setTruncated(result.truncated)
        setSkipped(result.skippedDirs)
        setExpanded(new Set())
      })
      .catch((cause: unknown) => {
        setEntries([])
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setLoading(false))
  }, [workspace])

  // 换工作区就重新枚举
  useEffect(() => {
    load()
  }, [load])

  const toggle = useCallback((rel: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }, [])

  const keyword = filter.trim().toLowerCase()

  const visible = useMemo(() => {
    const rows: { entry: WorkspaceEntry; depth: number }[] = []
    if (keyword !== '') {
      // 搜索时平铺展示命中项，不再受展开状态限制
      for (const entry of entries) {
        if (!entry.rel.toLowerCase().includes(keyword)) continue
        rows.push({ entry, depth: entry.rel.split('/').length - 1 })
        if (rows.length >= MAX_RENDER_ROWS) break
      }
      return rows
    }
    for (const entry of entries) {
      const segments = entry.rel.split('/')
      const depth = segments.length - 1
      // 祖先目录都展开才可见
      let visibleAncestor = true
      for (let i = 1; i < segments.length; i++) {
        if (!expanded.has(segments.slice(0, i).join('/'))) {
          visibleAncestor = false
          break
        }
      }
      if (!visibleAncestor) continue
      rows.push({ entry, depth })
      if (rows.length >= MAX_RENDER_ROWS) break
    }
    return rows
  }, [entries, expanded, keyword])

  const hiddenCount = entries.length - visible.length

  if (!workspace) {
    return (
      <div className="sidebar-section filetree-section">
        <div className="sidebar-section-label">工作区文件</div>
        <div className="filetree-empty">选择工作目录后显示文件树</div>
      </div>
    )
  }

  return (
    <div className="sidebar-section filetree-section">
      <div className="sidebar-section-label">
        <button
          type="button"
          className="filetree-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          title={collapsed ? '展开文件树' : '收起文件树'}
        >
          {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          工作区文件
        </button>
        <span className="sidebar-count">{entries.length}</span>
        <button
          type="button"
          className="icon-button filetree-refresh"
          title="重新扫描工作区"
          aria-label="重新扫描工作区"
          onClick={load}
        >
          {loading ? <Spinner size={11} /> : <IconRefresh size={12} />}
        </button>
      </div>

      {collapsed ? null : (
        <>
          {entries.length > 0 ? (
            <input
              className="filetree-filter"
              type="search"
              value={filter}
              placeholder="过滤文件名…"
              onChange={(event) => setFilter(event.target.value)}
            />
          ) : null}

          {error !== null ? <div className="sidebar-error">扫描失败：{error}</div> : null}

          {loading && entries.length === 0 ? <div className="filetree-empty">正在扫描…</div> : null}

          {!loading && entries.length === 0 && error === null ? (
            <div className="filetree-empty">这个目录是空的</div>
          ) : null}

          {visible.length > 0 ? (
            <ul className="filetree" data-ctx="filetree">
              {visible.map(({ entry, depth }) => {
                const indent = 6 + depth * 12
                if (entry.isDir) {
                  const open = expanded.has(entry.rel)
                  return (
                    <li key={entry.rel}>
                      <button
                        type="button"
                        className="ft-row ft-dir"
                        style={{ paddingLeft: indent }}
                        data-ctx="workspaceFile"
                        data-path={entry.path}
                        data-name={entry.name}
                        title={`${entry.rel}\n点击展开/收起；右键可复制路径、在资源管理器中显示`}
                        onClick={() => toggle(entry.rel)}
                      >
                        <span className="ft-caret" aria-hidden="true">
                          {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                        </span>
                        <span className="ft-icon" aria-hidden="true">
                          <IconFolder size={12} />
                        </span>
                        <span className="ft-name">{entry.name}</span>
                      </button>
                    </li>
                  )
                }
                return (
                  <li key={entry.rel}>
                    <button
                      type="button"
                      className="ft-row ft-file"
                      style={{ paddingLeft: indent }}
                      data-ctx="workspaceFile"
                      data-path={entry.path}
                      data-name={entry.name}
                      title={`${entry.rel}（${formatBytes(entry.size)}）\n点击：交给 Codex 理解\n右键：更多操作`}
                      onClick={() => onAttach([entry.path])}
                    >
                      <span className="ft-caret" aria-hidden="true" />
                      <span className="ft-icon" aria-hidden="true">
                        <IconFile size={12} />
                      </span>
                      <span className="ft-name">{entry.name}</span>
                      <span className="ft-size">{formatBytes(entry.size)}</span>
                      <span className="ft-attach" aria-hidden="true">
                        <IconAttach size={11} />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}

          <div className="filetree-foot">
            {hiddenCount > 0 ? <span>仅显示前 {MAX_RENDER_ROWS} 项，还有 {hiddenCount} 项未显示</span> : null}
            {truncated ? <span>目录过大，扫描已截断（上限 {2000} 项）</span> : null}
            {skipped.length > 0 ? <span title={skipped.join('、')}>已跳过 {skipped.length} 类依赖/构建目录</span> : null}
          </div>
        </>
      )}
    </div>
  )
}

export default WorkspaceFilesImpl
