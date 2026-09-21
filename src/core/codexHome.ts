/**
 * 生成 codex 运行环境：CODEX_HOME、provider 覆盖参数、子进程环境变量。
 *
 * 默认使用应用私有的 CODEX_HOME（~/.codex-desktop/codex-home/），
 * **绝不修改用户现有的 ~/.codex/config.toml**；用户也可以显式选择复用。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '../shared/types'
import { CODEX_HOME_DIR, USER_CODEX_HOME, ensureAppDirs } from './settings'

/** 传给 codex 子进程的 API Key 环境变量名 */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

export interface CodexRuntime {
  /** 子进程要用的 CODEX_HOME */
  codexHome: string
  /** -c key=value 覆盖项 */
  overrides: string[]
  /** 子进程额外环境变量 */
  env: Record<string, string>
  /** 实际使用的 provider base_url */
  providerBaseUrl: string
  /** 是否走了内置协议桥 */
  usingBridge: boolean
  /** 生成的 config.toml 路径（复用模式下为 null） */
  generatedConfigPath: string | null
}

/** TOML 字面量字符串：单引号内不做转义，最适合 Windows 路径 */
function tomlLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildConfigToml(opts: { settings: AppSettings; providerBaseUrl: string; workspace: string }): string {
  const lines: string[] = [
    '# 本文件由 codex-desktop 自动生成，应用启动时会覆盖，请勿手工编辑。',
    '# 想使用你自己的 ~/.codex/config.toml，请在「设置」里勾选「复用用户 Codex 配置」。',
    '',
    `model = ${tomlLiteral(opts.settings.model)}`,
    'model_provider = "deepseek"'
  ]

  // 上下文窗口必须显式声明：codex 不认识 deepseek-* 模型，否则会用兜底元数据，
  // 压缩时机算错，长会话要么提前压缩、要么直接超限报错。
  // 注意：TOML 的顶层键必须写在任何 [table] 之前。
  if (opts.settings.modelContextWindow > 0) {
    lines.push(
      '# 第三方模型的上下文窗口必须显式声明，否则 codex 用兜底元数据算压缩时机',
      `model_context_window = ${opts.settings.modelContextWindow}`
    )
  }
  if (opts.settings.autoCompactLimit > 0) {
    lines.push(`model_auto_compact_token_limit = ${opts.settings.autoCompactLimit}`)
  }

  lines.push(
    '',
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    `base_url = ${tomlLiteral(opts.providerBaseUrl)}`,
    `env_key = "${API_KEY_ENV}"`,
    'wire_api = "responses"',
    ''
  )
  if (opts.workspace) {
    lines.push(
      '# 让 codex 直接信任所选工作目录，避免非交互模式下卡在信任确认',
      `[projects.${tomlLiteral(opts.workspace)}]`,
      'trust_level = "trusted"',
      ''
    )
  }
  return lines.join('\n')
}

/**
 * 每轮任务开始前调用一次：桥的端口每次启动都可能变，所以这里会重写 config.toml。
 */
export function prepareCodexRuntime(opts: {
  settings: AppSettings
  bridgeBaseUrl: string
  workspace: string
}): CodexRuntime {
  ensureAppDirs()
  const { settings } = opts

  const usingBridge = !settings.useNativeResponses
  const providerBaseUrl = usingBridge ? opts.bridgeBaseUrl : settings.baseUrl
  const codexHome = settings.reuseUserCodexConfig ? USER_CODEX_HOME : CODEX_HOME_DIR

  let generatedConfigPath: string | null = null
  if (!settings.reuseUserCodexConfig) {
    generatedConfigPath = path.join(codexHome, 'config.toml')
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(
      generatedConfigPath,
      buildConfigToml({ settings, providerBaseUrl, workspace: opts.workspace }),
      'utf8'
    )
  }

  const overrides = [
    `model=${settings.model}`,
    'model_provider=deepseek',
    'model_providers.deepseek.name=DeepSeek',
    `model_providers.deepseek.base_url=${providerBaseUrl}`,
    `model_providers.deepseek.env_key=${API_KEY_ENV}`,
    'model_providers.deepseek.wire_api=responses'
  ]

  // 复用用户配置时也要把上下文窗口压过去（用户自己的 config.toml 里通常没有这些键）
  if (settings.modelContextWindow > 0) {
    overrides.push(`model_context_window=${settings.modelContextWindow}`)
  }
  if (settings.autoCompactLimit > 0) {
    overrides.push(`model_auto_compact_token_limit=${settings.autoCompactLimit}`)
  }

  return {
    codexHome,
    overrides,
    env: { [API_KEY_ENV]: settings.apiKey },
    providerBaseUrl,
    usingBridge,
    generatedConfigPath
  }
}

/** 读取用户 ~/.codex/config.toml 供设置页展示 */
export function inspectUserCodexConfig(): { path: string; exists: boolean; hasModelProvider: boolean; raw: string } {
  const file = path.join(USER_CODEX_HOME, 'config.toml')
  try {
    if (!fs.existsSync(file)) return { path: file, exists: false, hasModelProvider: false, raw: '' }
    const raw = fs.readFileSync(file, 'utf8')
    return { path: file, exists: true, hasModelProvider: /\[model_providers\./.test(raw), raw }
  } catch {
    return { path: file, exists: false, hasModelProvider: false, raw: '' }
  }
}
