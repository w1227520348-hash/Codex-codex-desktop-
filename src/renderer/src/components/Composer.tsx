import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ClipboardEvent, ReactNode } from 'react'
import { IconAttach, IconClose, IconSend, IconStop } from '@renderer/components/icons'
import { Spinner } from '@renderer/components/Spinner'
import { formatBytes } from '@renderer/utils/format'
import type { AttachmentRef } from '@shared/types'

export interface ComposerHandle {
  focus: () => void
  /** 外部（文件树右键、右键菜单动作）往输入框里塞文件 */
  addFiles: (paths: string[]) => void
  /** 移除某个附件（右键菜单用） */
  removeAttachment: (attachmentId: string) => void
  /** 清空输入框与附件（右键菜单用） */
  clear: () => void
}

export interface ComposerProps {
  running: boolean
  disabled: boolean
  disabledReason: string | null
  permissionLabel: string
  /** 附件要挂到哪个会话下面（没有会话时为 null，会落到 adhoc 目录） */
  sessionId: string | null
  workspace: string | null
  onSend: (prompt: string, attachments: AttachmentRef[]) => void | Promise<unknown>
  onStop: () => void | Promise<unknown>
}

/** 只有附件、没写文字时的兜底指令 */
const ATTACHMENT_ONLY_PROMPT = '请先阅读本轮提交的文件，然后告诉我你的理解。'

/**
 * 底部输入框：Enter 发送、Shift+Enter 换行。
 * 附件支持三种入口：附件按钮（隐藏的原生 file input）、拖拽、粘贴文件。
 */
const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { running, disabled, disabledReason, permissionLabel, sessionId, workspace, onSend, onStop }: ComposerProps,
  ref
): ReactNode {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  /** 把磁盘路径登记成附件（走主进程：拷贝 + 嗅探 + 读内联正文） */
  const addFiles = useCallback(
    (paths: string[]): void => {
      const usable = paths.filter((item) => typeof item === 'string' && item.trim() !== '')
      if (usable.length === 0) return
      setAttachBusy(true)
      void window.api
        .addAttachments(usable, sessionId, workspace)
        .then((result) => {
          setAttachments((current) => {
            const seen = new Set(current.map((item) => item.id))
            const fresh = result.attachments.filter((item) => !seen.has(item.id))
            return fresh.length === 0 ? current : [...current, ...fresh]
          })
          setAttachError(result.errors.length === 0 ? null : result.errors.map((e) => `${e.path}：${e.reason}`).join('；'))
        })
        .catch((error: unknown) => {
          setAttachError(`添加附件失败：${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => setAttachBusy(false))
    },
    [sessionId, workspace]
  )

  const removeAttachment = useCallback((attachmentId: string): void => {
    setAttachments((current) => {
      const hit = current.find((item) => item.id === attachmentId)
      if (hit) void window.api.removeAttachment(hit)
      return current.filter((item) => item.id !== attachmentId)
    })
  }, [])

  const clear = useCallback((): void => {
    setValue('')
    setAttachError(null)
    // 清空输入框不等于删文件：拷贝出来的副本留在会话目录里，用户可以再挑一次
    setAttachments([])
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      addFiles,
      removeAttachment,
      clear
    }),
    [addFiles, removeAttachment, clear]
  )

  const canSend = !disabled && !running && (value.trim() !== '' || attachments.length > 0)

  const submit = (): void => {
    if (!canSend) return
    const prompt = value.trim() === '' ? ATTACHMENT_ONLY_PROMPT : value
    const sent = attachments
    setValue('')
    setAttachments([])
    setAttachError(null)
    void onSend(prompt, sent)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  /** File[] → 真实磁盘路径（Electron 里 File.path 已被移除，必须问 preload） */
  const pathsFromFileList = (files: FileList | null): string[] => {
    if (!files) return []
    return Array.from(files)
      .map((file) => window.api.pathForFile(file))
      .filter((item) => item !== '')
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = event.clipboardData?.files
    if (!files || files.length === 0) return
    const paths = pathsFromFileList(files)
    if (paths.length === 0) return
    // 剪贴板里是文件：当附件处理，不要再往输入框里插路径文本
    event.preventDefault()
    addFiles(paths)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const paths = pathsFromFileList(event.dataTransfer?.files ?? null)
    if (paths.length > 0) addFiles(paths)
  }

  return (
    <div className="composer">
      <div
        className={[
          'composer-box',
          disabled ? 'composer-box-disabled' : '',
          dragging ? 'composer-box-drag' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 ? (
          <div className="attach-strip">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="attach-chip"
                data-ctx="attachment"
                data-path={attachment.path}
                data-name={attachment.name}
                data-attachment-id={attachment.id}
                title={`${attachment.path}${attachment.note ? `\n${attachment.note}` : ''}`}
              >
                <span className="attach-chip-icon" aria-hidden="true">
                  <IconAttach size={12} />
                </span>
                <span className="attach-chip-name">{attachment.name}</span>
                <span className="attach-chip-meta">{formatBytes(attachment.size)}</span>
                <span
                  className={attachment.inlined ? 'attach-chip-tag' : 'attach-chip-tag attach-chip-tag-tool'}
                  title={attachment.note ?? (attachment.inlined ? '正文已内联进提示词' : '交给 Codex 用工具读取')}
                >
                  {attachment.inlined ? '已内联' : '工具读取'}
                </span>
                <button
                  type="button"
                  className="attach-chip-remove"
                  title="移除这个附件"
                  aria-label={`移除附件 ${attachment.name}`}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <IconClose size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {attachError !== null ? <div className="attach-error">⚠ {attachError}</div> : null}

        <textarea
          ref={textareaRef}
          className="composer-input"
          data-ctx="composer"
          rows={3}
          value={value}
          placeholder="描述你要 Codex 做的事…（Enter 发送 / Shift+Enter 换行，可拖入或粘贴文件）"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          spellCheck={false}
        />

        <input
          ref={fileInputRef}
          className="attach-input"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            addFiles(pathsFromFileList(event.target.files))
            // 归零，否则连续选同一个文件不会再触发 change
            event.target.value = ''
          }}
        />

        <div className="composer-bar">
          <span className="composer-hint">
            {disabledReason ?? `权限模式：${permissionLabel} · ${value.trim().length} 字`}
          </span>

          <span className="composer-actions">
            <button
              type="button"
              className="button button-quiet button-sm"
              title="添加文件（也可以直接拖拽或粘贴文件到输入框）"
              disabled={disabled || attachBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {attachBusy ? <Spinner size={12} /> : <IconAttach size={13} />}
              附件
              {attachments.length > 0 ? ` ${attachments.length}` : ''}
            </button>

            {running ? (
              <button type="button" className="button button-danger" onClick={() => void onStop()}>
                <IconStop size={14} />
                停止
              </button>
            ) : (
              <button type="button" className="button button-primary" disabled={!canSend} onClick={submit}>
                {disabled ? <Spinner size={12} /> : <IconSend size={14} />}
                发送
              </button>
            )}
          </span>
        </div>
      </div>
      <div className="composer-foot">
        {attachments.length > 0
          ? `${attachments.length} 个文件会随本轮一起提交：小文本文件直接内联给模型，其余（大文件/二进制/图片）由 Codex 用工具按路径读取。`
          : 'Codex 会在你选择的工作目录里读文件、执行命令；所有动作都会显示在右侧「活动流」里。'}
      </div>
    </div>
  )
})

export default Composer
