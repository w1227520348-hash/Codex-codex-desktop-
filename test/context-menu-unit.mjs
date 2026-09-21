/**
 * 右键菜单模板的测试。
 *
 * 为什么值得单独测：Electron 的原生菜单（Menu.popup）无法用 CDP 点击，
 * 自动化测不到「点了会怎样」，但「什么位置该出现哪些项、哪些项该灰掉」
 * 是纯函数，可以完整钉死。
 *
 * 运行：node test/context-menu-unit.mjs
 */

import fs from 'node:fs'
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

const menu = await bundle('src/core/contextMenu.ts', 'contextMenu.bundle.mjs')

/* ---------------- 助手 ---------------- */
const labels = (items) => items.filter((i) => i.type !== 'separator').map((i) => i.label)
const actions = (items) => items.filter((i) => i.action).map((i) => i.action)
const roles = (items) => items.filter((i) => i.role).map((i) => i.role)
const find = (items, label) => items.find((i) => i.label === label)
const target = (kind, extra = {}) => ({ kind, at: Date.now(), ...extra })

const NO_EDIT = { isEditable: false, selectionText: '', editFlags: {} }
const EDIT = { isEditable: true, selectionText: '', editFlags: {} }

/** 结构不变量：不以分隔符开头、不以分隔符结尾、没有连续分隔符 */
function separatorInvariant(items) {
  if (items.length === 0) return true
  if (items[0].type === 'separator') return false
  if (items[items.length - 1].type === 'separator') return false
  for (let i = 1; i < items.length; i++) {
    if (items[i].type === 'separator' && items[i - 1].type === 'separator') return false
  }
  return true
}

/* ================= 1. 输入框 ================= */
console.log('──────── 1. 输入框（复制/粘贴等编辑动作）────────')
const editable = menu.buildContextMenu(target('composer'), EDIT)
record('输入框给出撤销/重做', roles(editable).includes('undo') && roles(editable).includes('redo'))
record(
  '输入框给出剪切/复制/粘贴/全选',
  ['cut', 'copy', 'paste', 'selectAll'].every((r) => roles(editable).includes(r)),
  roles(editable).join(',')
)
record('输入框额外给出「清空输入框」', actions(editable).includes('clear-composer'))
record('分隔符结构合法', separatorInvariant(editable))

const noSelection = menu.buildContextMenu(
  target('composer'),
  { isEditable: true, selectionText: '', editFlags: { canCut: true, canCopy: true, canPaste: true } }
)
record('没有选中文本时「剪切/复制」置灰', find(noSelection, '剪切').enabled === false && find(noSelection, '复制').enabled === false)

const withSelection = menu.buildContextMenu(
  target('composer'),
  { isEditable: true, selectionText: '选中的字', editFlags: { canCut: true, canCopy: true, canPaste: true } }
)
record('有选中文本时「剪切/复制」可用', find(withSelection, '剪切').enabled === true && find(withSelection, '复制').enabled === true)

const cannotPaste = menu.buildContextMenu(
  target('composer'),
  { isEditable: true, selectionText: '', editFlags: { canPaste: false } }
)
record('剪贴板没有内容时「粘贴」置灰', find(cannotPaste, '粘贴').enabled === false)
record(
  'editFlags 未提供时默认可用（不误灰）',
  menu.buildContextMenu(target('composer'), { isEditable: true, selectionText: '' }).find((i) => i.label === '粘贴').enabled !== false
)

// 输入框里挂了附件：右键附件 chip 时，编辑动作与附件动作应同时可用
const editableAttachment = menu.buildContextMenu(
  target('attachment', { path: 'C:\\a\\b.txt', attachmentId: 'abc' }),
  EDIT
)
record('输入框内右键附件：既有编辑动作也有附件动作', roles(editableAttachment).includes('paste') && actions(editableAttachment).includes('remove-attachment'))

/* ================= 2. 选中文本 ================= */
console.log('\n──────── 2. 非输入框的选中文本 ────────')
const selection = menu.buildContextMenu(target('message', { text: '正文' }), {
  isEditable: false,
  selectionText: '选中的一段',
  editFlags: {}
})
record('有选中文本时先给「复制选中文本」', selection[0].role === 'copy' && selection[0].label === '复制选中文本')
record('同时仍给该类型自己的动作', actions(selection).includes('copy-text'))

/* ================= 3. 各目标类型 ================= */
console.log('\n──────── 3. 各右键位置 ────────')
const messageMenu = menu.buildContextMenu(target('message', { text: '模型的回答', path: 'C:\\ws' }), NO_EDIT)
record('消息：复制这条消息 + 复制工作目录', labels(messageMenu).includes('复制这条消息') && labels(messageMenu).includes('复制工作目录'), labels(messageMenu).join(','))

record('代码块：复制代码', labels(menu.buildContextMenu(target('code', { text: 'const a = 1' }), NO_EDIT)).includes('复制代码'))
record('命令：复制命令', labels(menu.buildContextMenu(target('command', { text: 'Get-ChildItem' }), NO_EDIT)).includes('复制命令'))
record('输出：复制输出', labels(menu.buildContextMenu(target('output', { text: 'out' }), NO_EDIT)).includes('复制输出'))

const attachMenu = menu.buildContextMenu(target('attachment', { path: 'C:\\a\\b.txt', attachmentId: 'x1' }), NO_EDIT)
record(
  '附件：复制路径 / 显示 / 移除',
  labels(attachMenu).join(',') === '复制文件路径,在资源管理器中显示,移除这个附件',
  labels(attachMenu).join(',')
)

const fileMenu = menu.buildContextMenu(target('workspaceFile', { path: 'C:\\ws\\a.ts' }), NO_EDIT)
record(
  '工作区文件：交给 Codex 理解在最前',
  labels(fileMenu)[0] === '交给 Codex 理解',
  labels(fileMenu).join(',')
)
record('工作区文件：包含复制路径/显示/打开', ['复制路径', '在资源管理器中显示', '用默认程序打开'].every((l) => labels(fileMenu).includes(l)))
record('工作区文件：「交给 Codex 理解」的动作是 attach-paths', find(fileMenu, '交给 Codex 理解').action === 'attach-paths')

const sessionMenu = menu.buildContextMenu(target('session', { path: 'C:\\ws', sessionId: 's1' }), NO_EDIT)
record(
  '会话：复制/显示/打开工作目录',
  labels(sessionMenu).join(',') === '复制工作目录,在资源管理器中显示工作目录,打开工作目录',
  labels(sessionMenu).join(',')
)

const wsMenu = menu.buildContextMenu(target('workspace', { path: 'C:\\ws' }), NO_EDIT)
record('工作目录标签：复制路径 + 显示', labels(wsMenu).join(',') === '复制工作目录路径,在资源管理器中显示', labels(wsMenu).join(','))

record(
  '所有类型的分隔符结构都合法',
  [messageMenu, attachMenu, fileMenu, sessionMenu, wsMenu, editable, editableAttachment].every(separatorInvariant)
)

/* ================= 4. 灰掉与空菜单 ================= */
console.log('\n──────── 4. 缺信息时置灰 / 不弹空菜单 ────────')
const noText = menu.buildContextMenu(target('message', {}), NO_EDIT)
record('没有正文时「复制这条消息」置灰', find(noText, '复制这条消息').enabled === false)

const noPathFile = menu.buildContextMenu(target('workspaceFile', {}), NO_EDIT)
record('没有路径时「交给 Codex 理解」置灰', find(noPathFile, '交给 Codex 理解').enabled === false)

const nothing = menu.buildContextMenu(null, NO_EDIT)
record('什么都没有时返回空菜单（主进程据此不弹菜单）', nothing.length === 0, JSON.stringify(nothing))

/* ================= 5. 过期目标 ================= */
console.log('\n──────── 5. 过期目标 ────────')
const stale = menu.buildContextMenu({ kind: 'workspaceFile', path: 'C:\\a', at: Date.now() - 60_000 }, NO_EDIT)
record('过期目标被忽略（不按它的类型出菜单）', !labels(stale).includes('交给 Codex 理解'), labels(stale).join(','))
record('isStale 判定正确', menu.isStale({ kind: 'none', at: Date.now() - 60_000 }) === true && menu.isStale({ kind: 'none', at: Date.now() }) === false)
record('isStale 对 null 为真', menu.isStale(null) === true)

/* ================= 6. 被截断的内容 ================= */
console.log('\n──────── 6. 内容过长被截断 ────────')
const truncated = menu.buildContextMenu(
  target('output', { text: 'x'.repeat(1000), truncated: true }),
  NO_EDIT
)
record('截断时菜单里说明只复制了前多少字符', find(truncated, labels(truncated)[0]).label.includes('仅前'), labels(truncated)[0])
record('未截断时文案保持干净', labels(menu.buildContextMenu(target('output', { text: 'short' }), NO_EDIT))[0] === '复制输出')

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
}
process.exit(failed.length === 0 ? 0 : 1)
