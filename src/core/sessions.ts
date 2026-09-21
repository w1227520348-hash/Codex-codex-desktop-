/**
 * 会话（任务）持久化：~/.codex-desktop/sessions/<id>.json
 * 重启应用后仍可查看历史任务（需求 10）。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AttachmentRef,
  HarnessEvent,
  PermissionMode,
  SessionDetail,
  SessionSummary,
  SessionTurn
} from '../shared/types'
import { SESSIONS_DIR, ensureAppDirs } from './settings'

/** 单个字段的持久化上限，防止一次命令的巨量输出把会话文件撑爆 */
const MAX_FIELD_CHARS = 200_000

function sessionFile(id: string): string {
  return path.join(SESSIONS_DIR, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`)
}

/** 按 id 合并事件时用：把同一条目的 started/updated/completed 合成最终态 */
export function mergeEventInto(events: HarnessEvent[], event: HarnessEvent): void {
  if (
    (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') &&
    event.item &&
    'id' in event.item
  ) {
    const id = event.item.id
    const existingIndex = events.findIndex(
      (e) =>
        (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') &&
        e.item &&
        'id' in e.item &&
        e.item.id === id
    )
    if (existingIndex >= 0) {
      // 已完成的不再被 started 覆盖
      events[existingIndex] = event
      return
    }
  }
  events.push(event)
}

function truncate(value: string): string {
  if (value.length <= MAX_FIELD_CHARS) return value
  return `${value.slice(0, MAX_FIELD_CHARS)}\n…（输出过长，已截断，完整内容见工作区或 codex 会话日志）`
}

/** 持久化前裁剪超大字段 */
function shrinkEvent(event: HarnessEvent): HarnessEvent {
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    const item = event.item
    if (item.kind === 'command_execution') {
      return { ...event, item: { ...item, output: truncate(item.output) } }
    }
    if (item.kind === 'agent_message' || item.kind === 'reasoning') {
      return { ...event, item: { ...item, text: truncate(item.text) } }
    }
    if (item.kind === 'tool_call') {
      return { ...event, item: { ...item, output: truncate(item.output) } }
    }
  }
  return event
}

export function deriveTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return '未命名任务'
  return flat.length > 42 ? `${flat.slice(0, 42)}…` : flat
}

export function listSessions(): SessionSummary[] {
  ensureAppDirs()
  const summaries: SessionSummary[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const file of files) {
    try {
      const detail = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')) as SessionDetail
      if (!detail || typeof detail !== 'object' || !detail.id) continue
      summaries.push({
        id: detail.id,
        title: detail.title ?? '未命名任务',
        workspace: detail.workspace ?? '',
        model: detail.model ?? '',
        permissionMode: detail.permissionMode ?? 'workspace-write',
        createdAt: detail.createdAt ?? 0,
        updatedAt: detail.updatedAt ?? 0,
        status: detail.status ?? 'completed',
        hasContext: Boolean(detail.codexThreadId)
      })
    } catch {
      /* 跳过损坏的文件 */
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadSession(id: string): SessionDetail | null {
  try {
    const file = sessionFile(id)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionDetail
  } catch {
    return null
  }
}

export function saveSession(detail: SessionDetail): void {
  ensureAppDirs()
  const payload: SessionDetail = {
    ...detail,
    turns: detail.turns.map((turn) => ({ ...turn, events: turn.events.map(shrinkEvent) }))
  }
  const file = sessionFile(detail.id)
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    console.error('[sessions] 保存会话失败：', error)
  }
}

export function deleteSession(id: string): boolean {
  try {
    const file = sessionFile(id)
    if (!fs.existsSync(file)) return false
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export function createSession(
  workspace: string,
  model: string,
  permissionMode: PermissionMode
): SessionDetail {
  const now = Date.now()
  const detail: SessionDetail = {
    id: randomUUID(),
    title: '新任务',
    workspace,
    model,
    permissionMode,
    createdAt: now,
    updatedAt: now,
    status: 'completed',
    turns: []
  }
  saveSession(detail)
  return detail
}

export function createTurn(prompt: string, attachments?: AttachmentRef[]): SessionTurn {
  return {
    id: randomUUID(),
    prompt,
    startedAt: Date.now(),
    status: 'running',
    events: [],
    ...(attachments && attachments.length > 0 ? { attachments } : {})
  }
}
