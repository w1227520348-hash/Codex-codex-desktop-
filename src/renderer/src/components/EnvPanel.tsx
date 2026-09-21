import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@renderer/components/Badge'
import { Spinner } from '@renderer/components/Spinner'
import { IconClose, IconRefresh } from '@renderer/components/icons'
import type { EnvReport } from '@shared/types'

export interface EnvPanelProps {
  open: boolean
  report: EnvReport | null
  loading: boolean
  onClose: () => void
  onRefresh: () => Promise<void> | void
}

interface PingResult {
  local: boolean
  upstream: boolean
  message: string
}

/** 环境自检面板：EnvReport 明细 + codex 版本 + 连通性测试 */
function EnvPanel({ open, report, loading, onClose, onRefresh }: EnvPanelProps): ReactNode {
  const [ping, setPing] = useState<PingResult | null>(null)
  const [pinging, setPinging] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const runPing = async (): Promise<void> => {
    setPinging(true)
    setPingError(null)
    try {
      const result = await window.api.pingBridge()
      setPing(result)
    } catch (cause) {
      setPing(null)
      setPingError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPinging(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="环境自检"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 className="modal-title">环境自检</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal-body">
          <div className="env-summary">
            <div className="env-summary-item">
              <span className="env-summary-label">操作系统</span>
              <span className="env-summary-value">{report?.os ?? '未知'}</span>
            </div>
            <div className="env-summary-item">
              <span className="env-summary-label">codex 路径</span>
              <span className="env-summary-value" title={report?.codexPath ?? ''}>
                {report?.codexPath ?? '未找到'}
              </span>
            </div>
            <div className="env-summary-item">
              <span className="env-summary-label">codex 版本</span>
              <span className="env-summary-value">{report?.codexVersion ?? '未知'}</span>
            </div>
            <div className="env-summary-item">
              <span className="env-summary-label">检查时间</span>
              <span className="env-summary-value">
                {report ? new Date(report.checkedAt).toLocaleString('zh-CN') : '尚未检查'}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="env-loading">
              <Spinner size={14} /> 正在检查…
            </div>
          ) : null}

          {!loading && !report ? <div className="panel-empty">还没有检查结果，点下面的「重新检查」。</div> : null}

          {report ? (
            <ul className="env-list">
              {report.items.map((item, index) => (
                <li className={['env-item', item.ok ? 'env-ok' : 'env-bad'].filter(Boolean).join(' ')} key={`${item.label}-${index}`}>
                  <span className="env-mark" aria-hidden="true">
                    {item.ok ? '✓' : '✕'}
                  </span>
                  <span className="env-label">{item.label}</span>
                  <span className="env-value">{item.value}</span>
                  {item.hint ? <span className="env-hint">{item.hint}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="env-ping">
            <div className="env-ping-head">
              <span className="env-ping-title">连通性测试</span>
              <button type="button" className="button button-ghost button-sm" onClick={() => void runPing()} disabled={pinging}>
                {pinging ? '测试中…' : '测试连通性'}
              </button>
            </div>

            {pingError ? <div className="field-error">测试失败：{pingError}</div> : null}

            {ping ? (
              <div className="env-ping-result">
                <Badge tone={ping.local ? 'success' : 'danger'}>本地桥：{ping.local ? '正常' : '不可用'}</Badge>
                <Badge tone={ping.upstream ? 'success' : 'danger'}>上游模型：{ping.upstream ? '正常' : '不可用'}</Badge>
                <div className="env-ping-message">{ping.message}</div>
              </div>
            ) : (
              <div className="field-hint">会同时探测本地桥与 DeepSeek 端点。</div>
            )}
          </div>
        </div>

        <footer className="modal-foot">
          <span className="modal-foot-hint">
            {report && report.items.some((item) => !item.ok) ? '存在未通过项，请按提示修复。' : '检查结果仅供参考。'}
          </span>
          <button type="button" className="button button-ghost" onClick={() => void onRefresh()}>
            <IconRefresh size={13} />
            重新检查
          </button>
          <button type="button" className="button button-primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}

export default EnvPanel
