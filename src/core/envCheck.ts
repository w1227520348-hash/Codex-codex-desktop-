/**
 * 环境自检：把「本机能不能跑起来」这件事在 UI 里说清楚。
 */

import fs from 'node:fs'
import os from 'node:os'
import type { EnvCheckItem, EnvReport } from '../shared/types'
import { resolveCodexCli } from './codexCli'
import { inspectUserCodexConfig } from './codexHome'
import type { AppSettings } from '../shared/types'

export interface EnvCheckInput {
  settings: AppSettings
  bridgeRunning: boolean
  bridgeBaseUrl: string
  bridgeUpstream: string
}

export async function checkEnvironment(input: EnvCheckInput): Promise<EnvReport> {
  const items: EnvCheckItem[] = []

  items.push({
    label: '操作系统',
    value: `${os.type()} ${os.release()} (${process.arch})`,
    ok: true
  })

  items.push({
    label: 'Node.js',
    value: process.version,
    ok: true
  })

  const cli = await resolveCodexCli(true)
  items.push({
    label: 'codex CLI',
    value: cli ? `${cli.version ?? '未知版本'}` : '未找到',
    ok: Boolean(cli),
    hint: cli
      ? undefined
      : '未找到 @openai/codex。请执行 `npm i -g @openai/codex`（可用国内镜像 --registry=https://registry.npmmirror.com）'
  })

  if (cli) {
    items.push({ label: 'codex 入口', value: cli.entry, ok: true })
    const major = cli.version?.split('.').map((n) => Number.parseInt(n, 10)) ?? []
    const tooOld = Number.isFinite(major[0]) && (major[0] < 0 || (major[0] === 0 && Number.isFinite(major[1]) && major[1] < 20))
    items.push({
      label: 'codex 版本兼容性',
      value: tooOld ? '版本偏旧' : '支持 --json 事件流',
      ok: !tooOld,
      hint: tooOld ? '建议升级到 0.4x 以上版本以获得 --json 事件流' : undefined
    })
  }

  items.push({
    label: 'DeepSeek API Key',
    value: input.settings.apiKey.length > 0 ? `已配置（${input.settings.apiKey.slice(0, 6)}…）` : '未配置',
    ok: input.settings.apiKey.length > 0,
    hint: input.settings.apiKey.length > 0 ? undefined : '在「设置」里填入 DeepSeek API Key（仅保存在本机 ~/.codex-desktop/config.json）'
  })

  items.push({
    label: '模型',
    value: `${input.settings.model}（temperature ${input.settings.temperature}）`,
    ok: true
  })

  items.push({
    label: input.settings.useNativeResponses ? 'DeepSeek 原生 Responses 直连' : '内置协议桥',
    value: input.settings.useNativeResponses ? input.settings.baseUrl : input.bridgeBaseUrl,
    ok: input.settings.useNativeResponses || input.bridgeRunning,
    hint: input.settings.useNativeResponses
      ? '若该账号/模型不支持 /v1/responses 会直接报 404，可关闭此选项改用协议桥'
      : undefined
  })

  if (!input.settings.useNativeResponses) {
    items.push({
      label: '桥的目标上游',
      value: input.bridgeUpstream,
      ok: true
    })
  }

  const userConfig = inspectUserCodexConfig()
  items.push({
    label: '用户 Codex 配置',
    value: userConfig.exists
      ? `${userConfig.path}${userConfig.hasModelProvider ? '（含自定义 provider）' : ''}`
      : '不存在（不影响使用）',
    ok: true
  })

  items.push({
    label: 'CODEX_HOME 策略',
    value: input.settings.reuseUserCodexConfig ? '复用 ~/.codex' : '应用私有 ~/.codex-desktop/codex-home',
    ok: true
  })

  items.push({
    label: '配置目录',
    value: os.homedir() + '\\.codex-desktop',
    ok: fs.existsSync(os.homedir() + '\\.codex-desktop'),
    hint: '首次保存设置或启动任务后自动创建'
  })

  return {
    os: `${os.type()} ${os.release()}`,
    items,
    codexPath: cli?.entry ?? null,
    codexVersion: cli?.version ?? null,
    checkedAt: Date.now()
  }
}
