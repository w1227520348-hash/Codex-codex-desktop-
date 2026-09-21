/**
 * 工作区文件枚举的测试：有界遍历、重目录跳过、顺序稳定、上限截断。
 * 运行：node test/workspace-files-unit.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const tmpDir = path.join(root, '.tmp')
fs.mkdirSync(tmpDir, { recursive: true })

async function bundle(entry, outfile) {
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: path.join(tmpDir, outfile),
    alias: { '@shared/types': path.join(root, 'src/shared/types.ts') },
    logLevel: 'warning'
  })
  return import(pathToFileURL(path.join(tmpDir, outfile)).href)
}

const files = await bundle('src/core/workspaceFiles.ts', 'workspaceFiles.bundle.mjs')

/* ---------------- 夹具：一个「小仓库」 ---------------- */
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ws-'))
const write = (rel, content = 'x') => {
  const target = path.join(ws, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
write('README.md', 'readme')
write('src/index.ts', 'export {}')
write('src/util/helper.ts', 'export {}')
write('src/assets/logo.svg', '<svg/>')
write('node_modules/left-pad/index.js', 'module.exports=1')
write('node_modules/.bin/thing', 'bin')
write('.git/config', '[core]')
write('dist/bundle.js', 'bundle')
write('out/main.js', 'main')
write('__pycache__/mod.pyc', 'cache')
write('.venv/pyvenv.cfg', 'home = x')
// 超过默认深度（4 层）的嵌套
write('a/b/c/d/e/deep.txt', 'deep')

const result = files.listWorkspaceFilesResult(ws)
const rels = result.entries.map((e) => e.rel)
const names = result.entries.map((e) => e.name)

console.log(`夹具工作区：${ws}\n`)

/* ================= 1. 基本内容与顺序 ================= */
console.log('──────── 1. 内容与顺序 ────────')
record('列出了工作区里的普通文件', rels.includes('README.md') && rels.includes('src/index.ts'))
record('列出了子目录里的文件', rels.includes('src/util/helper.ts'))
record('目录本身也作为条目返回', result.entries.find((e) => e.rel === 'src')?.isDir === true)
record('文件带上了大小', result.entries.find((e) => e.rel === 'README.md')?.size === 6)

const srcIndex = rels.indexOf('src')
// 前序性质：目录之后紧跟的必须是它自己的子孙（同级里目录排在文件前，
// 所以 src/index.ts 出现在 src/assets/... 之后是正常的）
record(
  '目录后面紧跟的是它自己的子孙（前序）',
  srcIndex >= 0 && rels[srcIndex + 1].startsWith('src/'),
  `src@${srcIndex} → ${rels[srcIndex + 1]}`
)
record(
  '每个条目的父目录都排在它前面',
  rels.every((rel) => {
    if (!rel.includes('/')) return true
    const parent = rel.slice(0, rel.lastIndexOf('/'))
    return rels.indexOf(parent) >= 0 && rels.indexOf(parent) < rels.indexOf(rel)
  })
)
const rootDirs = result.entries.filter((e) => !e.rel.includes('/')).map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`)
record('同一层里目录排在文件前面', rootDirs.join(',').startsWith('d:'), rootDirs.join(','))
record(
  '同一层内按名字排序',
  (() => {
    const dirs = result.entries.filter((e) => !e.rel.includes('/') && e.isDir).map((e) => e.name)
    return JSON.stringify(dirs) === JSON.stringify([...dirs].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  })(),
  result.entries.filter((e) => !e.rel.includes('/') && e.isDir).map((e) => e.name).join(',')
)
record(
  '输出稳定：连跑两次结果一致',
  JSON.stringify(files.listWorkspaceFiles(ws)) === JSON.stringify(files.listWorkspaceFiles(ws))
)

/* ================= 2. 跳过重目录 ================= */
console.log('\n──────── 2. 重目录跳过 ────────')
const heavy = ['node_modules', '.git', 'dist', 'out', '__pycache__', '.venv']
for (const dir of heavy) {
  record(`不进入 ${dir}`, !names.includes(dir) && !rels.some((r) => r.startsWith(`${dir}/`)))
}
record('被跳过的目录名会被记录下来（便于向用户解释）', heavy.every((d) => result.skippedDirs.includes(d)), result.skippedDirs.join(','))
record('点文件没有被误当成目录跳过', rels.includes('src/assets/logo.svg'))

/* ================= 3. 深度与条目上限 ================= */
console.log('\n──────── 3. 深度与上限 ────────')
record('默认不遍历超深目录（a/b/c/d 是第 4 层，e 是第 5 层）', rels.includes('a/b/c/d') && !rels.includes('a/b/c/d/e'), rels.filter((r) => r.startsWith('a/')).join(','))
record('depth 只是目录条目本身，深度上限按目录层级算', !rels.some((r) => r.includes('deep.txt')))

const depth1 = files.listWorkspaceFilesResult(ws, { maxDepth: 1 })
record('maxDepth=1 只列第一层', depth1.entries.every((e) => !e.rel.includes('/')), depth1.entries.map((e) => e.rel).join(','))

const capped = files.listWorkspaceFilesResult(ws, { maxEntries: 3 })
record('maxEntries 生效', capped.entries.length === 3, `实际 ${capped.entries.length}`)
record('被截断时标记 truncated', capped.truncated === true)
record('没截断时不标记', result.truncated === false)
record('截断时返回的仍是前 3 个（顺序不变）', JSON.stringify(capped.entries.map((e) => e.rel)) === JSON.stringify(rels.slice(0, 3)))

/* ================= 4. 异常输入 ================= */
console.log('\n──────── 4. 异常输入 ────────')
const missing = files.listWorkspaceFilesResult(path.join(ws, 'nope'))
record('不存在的目录返回空列表而不抛错', missing.entries.length === 0 && missing.truncated === false)
const notDir = files.listWorkspaceFilesResult(path.join(ws, 'README.md'))
record('传入文件路径返回空列表', notDir.entries.length === 0)

try {
  fs.rmSync(ws, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
}
process.exit(failed.length === 0 ? 0 : 1)
