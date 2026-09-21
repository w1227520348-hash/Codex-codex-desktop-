import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconClose } from '@renderer/components/icons'
import type { AppSettings, HarnessEngine, PermissionMode, ThemeMode } from '@shared/types'
import {
  CONTEXT_WINDOW_OPTIONS,
  ENGINE_HINTS,
  ENGINE_LABELS,
  KNOWN_MODELS,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS
} from '@shared/types'

export interface SettingsPanelProps {
  open: boolean
  settings: AppSettings
  resolvedTheme: 'light' | 'dark'
  onClose: () => void
  onSave: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
}

const PERMISSION_MODES: PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access']

const ENGINES: HarnessEngine[] = ['app-server', 'exec']

const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'dark', label: '深色', hint: '默认' },
  { value: 'light', label: '浅色', hint: '白天使用' },
  { value: 'system', label: '跟随系统', hint: '由操作系统决定' }
]

interface CodexConfigInfo {
  path: string
  exists: boolean
  hasModelProvider: boolean
  raw: string
}

/** 设置面板（模态）：模型 / Key / 采样 / 权限 / 主题 */
function SettingsPanel({ open, settings, resolvedTheme, onClose, onSave }: SettingsPanelProps): ReactNode {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saving, setSaving] = useState(false)
  const [configInfo, setConfigInfo] = useState<CodexConfigInfo | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setDraft(settings)
      setSaving(false)
    }
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const patch = (value: Partial<AppSettings>): void => {
    setDraft((current) => ({ ...current, ...value }))
  }

  const dirty = (Object.keys(draft) as (keyof AppSettings)[]).some((key) => {
    const before = settings[key]
    const after = draft[key]
    if (Array.isArray(before) && Array.isArray(after)) return before.join('|') !== after.join('|')
    return before !== after
  })

  const commit = async (): Promise<void> => {
    if (!dirty) {
      onClose()
      return
    }
    setSaving(true)
    const result = await onSave({
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim() === '' ? settings.model : draft.model.trim(),
      temperature: clampTemperature(draft.temperature),
      modelContextWindow: Math.max(1024, Math.round(draft.modelContextWindow || 0)),
      autoCompactLimit: Math.max(0, Math.round(draft.autoCompactLimit || 0)),
      baseUrl: draft.baseUrl.trim(),
      reuseUserCodexConfig: draft.reuseUserCodexConfig,
      useNativeResponses: draft.useNativeResponses,
      permissionMode: draft.permissionMode,
      engine: draft.engine,
      theme: draft.theme,
      maxOutputTokens: Math.max(0, Math.round(draft.maxOutputTokens || 0))
    })
    setSaving(false)
    if (result) onClose()
  }

  const inspectConfig = async (): Promise<void> => {
    setConfigError(null)
    try {
      const info = await window.api.inspectUserCodexConfig()
      setConfigInfo(info)
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 className="modal-title">设置</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal-body">
          {draft.apiKey.trim() === '' ? (
            <div className="notice notice-warn">
              <span className="notice-icon" aria-hidden="true">
                ⚠
              </span>
              <div className="notice-body">
                <div className="notice-title">API Key 为空</div>
                <div className="notice-text">没有 Key 时无法调用模型，任务会直接失败。</div>
              </div>
            </div>
          ) : null}

          <div className="field">
            <label className="field-label" htmlFor="setting-model">
              模型
            </label>
            <input
              id="setting-model"
              className="input"
              list="known-models"
              value={draft.model}
              onChange={(event) => patch({ model: event.target.value })}
              placeholder="例如 deepseek-chat"
              spellCheck={false}
            />
            <datalist id="known-models">
              {KNOWN_MODELS.map((model) => (
                <option key={model.id} value={model.id} label={model.hint} />
              ))}
            </datalist>
            <div className="field-hint">
              可选：{KNOWN_MODELS.map((model) => `${model.label}（${model.hint}）`).join('；')}。也可以直接手填其它模型名。
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="setting-key">
              DeepSeek API Key
            </label>
            <input
              id="setting-key"
              className="input"
              type="password"
              value={draft.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="field-hint">仅保存在本机 ~/.codex-desktop/config.json，不会上传。</div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="setting-baseurl">
              API 端点（baseUrl）
            </label>
            <input
              id="setting-baseurl"
              className="input"
              value={draft.baseUrl}
              onChange={(event) => patch({ baseUrl: event.target.value })}
              placeholder="https://api.deepseek.com/v1"
              spellCheck={false}
            />
            <div className="field-hint">必须是 OpenAI 兼容的 /v1 根地址。</div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="setting-temp">
              温度（temperature）：{draft.temperature.toFixed(1)}
            </label>
            <input
              id="setting-temp"
              className="range"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              onChange={(event) => patch({ temperature: clampTemperature(Number(event.target.value)) })}
            />
            <div className="field-hint">0 更确定、2 更发散；由内置桥在转发请求时注入。</div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="setting-tokens">
              单次最大输出 token（maxOutputTokens）
            </label>
            <input
              id="setting-tokens"
              className="input"
              type="number"
              min={0}
              step={1024}
              value={draft.maxOutputTokens}
              onChange={(event) => patch({ maxOutputTokens: Math.max(0, Math.round(Number(event.target.value) || 0)) })}
            />
            <div className="field-hint">填 0 表示不限制，交给服务端默认值。</div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="setting-context">
              上下文窗口（model_context_window）
            </label>
            <div className="segmented">
              {CONTEXT_WINDOW_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={['segment', draft.modelContextWindow === option.value ? 'segment-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => patch({ modelContextWindow: option.value })}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <input
              id="setting-context"
              className="input"
              type="number"
              min={1024}
              step={1024}
              value={draft.modelContextWindow}
              onChange={(event) => patch({ modelContextWindow: Math.max(1024, Math.round(Number(event.target.value) || 0)) })}
            />
            <div className="field-hint">
              <strong>必须填对</strong>：codex 不认识 deepseek-* 模型，不声明就会用兜底元数据算压缩时机，
              长会话要么提前压缩、要么直接超限报错。默认 64K（DeepSeek V3 系历史值），
              确认你的模型支持更长上下文再调大。
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="setting-compact">
              自动压缩阈值（model_auto_compact_token_limit）
            </label>
            <input
              id="setting-compact"
              className="input"
              type="number"
              min={0}
              step={1024}
              value={draft.autoCompactLimit}
              onChange={(event) => patch({ autoCompactLimit: Math.max(0, Math.round(Number(event.target.value) || 0)) })}
            />
            <div className="field-hint">
              填 0 = 由 codex 依据上面声明的窗口自行决定（推荐）。填数值则超过该 token 数就自动压缩上下文。
            </div>
          </div>

          <div className="field">
            <div className="field-label">驱动引擎</div>
            <div className="option-list">
              {ENGINES.map((value) => (
                <label
                  className={['option', draft.engine === value ? 'option-active' : ''].filter(Boolean).join(' ')}
                  key={value}
                >
                  <input
                    type="radio"
                    name="engine"
                    checked={draft.engine === value}
                    onChange={() => patch({ engine: value })}
                  />
                  <span className="option-main">
                    <span className="option-label">{ENGINE_LABELS[value]}</span>
                    <span className="option-hint">{ENGINE_HINTS[value]}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="field-hint">
              审批模式使用 codex 的 app-server 协议（实验性）。若该协议不可用，应用会自动回退到稳定模式并在对话区提示。
            </div>
          </div>

          <div className="field">
            <div className="field-label">权限模式</div>
            <div className="option-list">
              {PERMISSION_MODES.map((mode) => (
                <label
                  className={['option', draft.permissionMode === mode ? 'option-active' : ''].filter(Boolean).join(' ')}
                  key={mode}
                >
                  <input
                    type="radio"
                    name="permission-mode"
                    checked={draft.permissionMode === mode}
                    onChange={() => patch({ permissionMode: mode })}
                  />
                  <span className="option-main">
                    <span className="option-label">{PERMISSION_MODE_LABELS[mode]}</span>
                    <span className="option-hint">{PERMISSION_MODE_HINTS[mode]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="field-label">主题</div>
            <div className="segmented">
              {THEME_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={['segment', draft.theme === option.value ? 'segment-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => patch({ theme: option.value })}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="field-hint">当前实际生效：{resolvedTheme === 'dark' ? '深色' : '浅色'}</div>
          </div>

          <div className="field">
            <label className="option option-check">
              <input
                type="checkbox"
                checked={draft.reuseUserCodexConfig}
                onChange={(event) => patch({ reuseUserCodexConfig: event.target.checked })}
              />
              <span className="option-main">
                <span className="option-label">复用用户 Codex 配置</span>
                <span className="option-hint">勾选后复用 ~/.codex/config.toml（含你自己配的 model_provider 等）。</span>
              </span>
            </label>

            <label className="option option-check">
              <input
                type="checkbox"
                checked={draft.useNativeResponses}
                onChange={(event) => patch({ useNativeResponses: event.target.checked })}
              />
              <span className="option-main">
                <span className="option-label">直连 DeepSeek 原生 Responses API</span>
                <span className="option-hint">
                  勾选后跳过内置协议桥，直接把 base_url 交给 codex。只有确认你的账号/模型支持
                  POST /v1/responses 时才打开，否则会 404。
                </span>
              </span>
            </label>

            <div className="inline-row">
              <button type="button" className="button button-ghost button-sm" onClick={() => void inspectConfig()}>
                检查 ~/.codex/config.toml
              </button>
              {configInfo ? (
                <span className="field-hint">
                  {configInfo.exists ? '已找到' : '不存在'} · 自定义 provider：
                  {configInfo.hasModelProvider ? '有' : '无'} · {configInfo.path}
                </span>
              ) : null}
            </div>

            {configError ? <div className="field-error">读取失败：{configError}</div> : null}

            {configInfo && configInfo.raw.trim() !== '' ? (
              <details className="config-raw">
                <summary>查看原始内容</summary>
                <pre className="code-block">{configInfo.raw}</pre>
              </details>
            ) : null}
          </div>
        </div>

        <footer className="modal-foot">
          <span className="modal-foot-hint">{dirty ? '有未保存的改动' : '没有改动'}</span>
          <button type="button" className="button button-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="button button-primary" onClick={() => void commit()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(2, Math.max(0, Math.round(value * 10) / 10))
}

export default SettingsPanel
