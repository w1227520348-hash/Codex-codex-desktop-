/**
 * 应用自身的路径解析。
 *
 * 之所以单独抽出来：为了让「压缩包 → 解压到另一台电脑」也能用，
 * 需要知道应用根目录以便：
 *   1. 找到**随包一起带走的** codex（<root>/node_modules/@openai/codex），不必依赖全局安装
 *   2. 支持**便携模式**：只要根目录存在 portable.flag，就把配置/会话写到 <root>/data，
 *      这样整个文件夹复制到哪台机器都能连配置一起带走
 *
 * 实现上只用 node:path + node:fs，不依赖 Electron，便于在测试与脚本里复用。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 便携模式标记文件（放在应用根目录） */
export const PORTABLE_FLAG = 'portable.flag'
/** 便携模式下的数据目录名 */
export const PORTABLE_DATA_DIR = 'data'

/**
 * 从若干「运行时锚点」向上找带 package.json 的目录，作为应用根目录。
 *
 * 不能用 `import.meta.url`：主进程会被打包成 CJS，那里没有 import.meta。
 * 也不只用 `__dirname`：测试/脚本里的 esbuild 产物是 ESM，那里没有 __dirname。
 * 所以两者都试（`typeof` 对未声明标识符不会抛错），再加 Electron 打包后的 resourcesPath。
 */
export function findAppRoot(): string | null {
  const anchors: string[] = []

  // CJS（Electron 主进程）：<root>/out/main/index.js → 命中 <root>
  if (typeof __dirname === 'string') anchors.push(__dirname)
  // 通用：入口脚本所在目录（CJS/ESM 都有），esbuild 产物在 <root>/.tmp → 也命中 <root>
  if (process.argv[1]) anchors.push(path.dirname(process.argv[1]))
  // Electron 打包后
  if (process.resourcesPath) {
    anchors.push(process.resourcesPath, path.join(process.resourcesPath, 'app'))
  }

  for (const anchor of anchors) {
    let dir = anchor
    for (let i = 0; i < 4; i++) {
      try {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      } catch {
        /* ignore */
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/** 便携模式的数据目录；未启用或不可写时返回 null（自动退回 ~/.codex-desktop） */
export function portableDataDir(): string | null {
  const root = findAppRoot()
  if (!root) return null
  try {
    if (!fs.existsSync(path.join(root, PORTABLE_FLAG))) return null
    const dir = path.join(root, PORTABLE_DATA_DIR)
    // 顺手确认可写：如果别人把包解压到 Program Files 这类只读位置，
    // 便携模式会写失败 —— 这时应当自动退回用户目录，而不是直接崩。
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return dir
  } catch {
    return null
  }
}

/** 随包携带的 codex 入口（若存在） */
export function bundledCodexEntry(): string | null {
  const root = findAppRoot()
  if (!root) return null
  const candidate = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  try {
    return fs.existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}
