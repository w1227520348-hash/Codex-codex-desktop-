import { memo } from 'react'
import type { ReactNode } from 'react'
import Markdown from '@renderer/components/Markdown'
import FittedImage from '@renderer/components/FittedImage'
import { useAppearanceRuntime, useSlotImage } from '@renderer/hooks/useAppearance'
import { formatClock } from '@renderer/utils/format'

export interface MessageBubbleProps {
  role: 'user' | 'assistant'
  text: string
  time?: number
  streaming?: boolean
}

/** 对话气泡：用户靠右纯文本，助手靠左走 Markdown */
function MessageBubbleImpl({ role, text, time, streaming = false }: MessageBubbleProps): ReactNode {
  const isUser = role === 'user'
  const runtime = useAppearanceRuntime()
  const avatar = useSlotImage(isUser ? 'userAvatar' : 'assistantAvatar')
  const showAvatar = runtime.appearance.showAvatars

  return (
    <div className={['bubble-row', isUser ? 'bubble-row-user' : 'bubble-row-assistant'].join(' ')}>
      {showAvatar ? (
        <div className={['bubble-avatar', isUser ? 'bubble-avatar-user' : 'bubble-avatar-assistant'].join(' ')}>
          {avatar.src ? (
            // 自定义头像：由 FittedImage 保证 cover 居中、不拉伸、不溢出，圆形框内裁成圆
            <FittedImage
              source={avatar.src}
              transform={runtime.appearance.slots[isUser ? 'userAvatar' : 'assistantAvatar']?.transform}
              onError={avatar.onError}
            />
          ) : (
            <span className="bubble-avatar-text">{isUser ? '你' : 'AI'}</span>
          )}
        </div>
      ) : null}
      <div className={['bubble', isUser ? 'bubble-user' : 'bubble-assistant'].join(' ')}>
        <div className="bubble-meta">
          <span className="bubble-role">{isUser ? '你' : 'Codex'}</span>
          {time ? <span className="bubble-time">{formatClock(time)}</span> : null}
        </div>
        <div className="bubble-body" data-ctx="message">
          {isUser ? <p className="bubble-plain">{text}</p> : <Markdown source={text} streaming={streaming} />}
        </div>
      </div>
    </div>
  )
}

const MessageBubble = memo(MessageBubbleImpl)
export default MessageBubble
