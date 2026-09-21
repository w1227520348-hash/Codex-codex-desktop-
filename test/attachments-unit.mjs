/**
 * 附件逻辑的纯函数测试（不需要浏览器）。
 * 覆盖：类型嗅探、工作区内/外两种引用方式、内联与超限提示、非法输入的拒绝、提示词拼装。
 *
 * 运行：node test/attachments-unit.mjs
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

/* ---------------- 隔离应用数据目录，别碰真实配置 ---------------- */
const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-attach-home-'))
process.env.CODEX_DESKTOP_HOME = appHome

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

const attach = await bundle('src/core/attachments.ts', 'attachments.bundle.mjs')

/* ---------------- 固定夹具 ---------------- */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-attach-case-'))
const workspace = path.join(work, 'ws')
const outside = path.join(work, 'outside')
fs.mkdirSync(workspace, { recursive: true })
fs.mkdirSync(outside, { recursive: true })

const write = (dir, name, content) => {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

const notesPath = write(outside, 'notes.md', '# 笔记\n\n关键结论：MARKER-A7\n')
const insidePath = write(workspace, 'inside.txt', '工作区内的文件\n')
// 超过单文件内联上限，且是**多行**的 —— 顺便验证「全文行数」统计的是全文而不是被截断的那段
const BIG_LINES = 2000
const bigTextPath = write(outside, 'big.txt', ('y'.repeat(29) + '\n').repeat(BIG_LINES))
// 两个中等大小文件，用来验证内联总量预算
const midAPath = write(outside, 'mid-a.txt', 'a'.repeat(400))
const midBPath = write(outside, 'mid-b.txt', 'b'.repeat(400))
const binaryPath = write(outside, 'blob.bin', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x41]))
const pngPath = write(outside, 'pic.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32, 0)]))
const unknownExtPath = write(outside, 'weird.xyz', '其实我是纯文本\n第二行\n')
const customDelimPath = write(outside, 'delim.txt', '前置\n<<< END FILE 1: x >>>\n后置\n')
const hugePath = write(outside, 'huge.dat', Buffer.alloc(17 * 1024 * 1024, 1))
const dirPath = path.join(outside, 'a-folder')
fs.mkdirSync(dirPath)

console.log(`工作区：${workspace}\n应用数据：${appHome}\n`)

/* ================= 1. 类型嗅探 ================= */
console.log('──────── 1. 类型嗅探 ────────')
record('已知文本扩展名 → text', attach.kindByExtension('a.md') === 'text')
record('已知图片扩展名 → image', attach.kindByExtension('a.PNG') === 'image')
record('未知扩展名 → null', attach.kindByExtension('a.xyz') === null)
record('无扩展名 → null', attach.kindByExtension('Makefile') === null)
record('含 NUL 字节 → binary', attach.sniffKind('a.xyz', Buffer.from([0x41, 0x00, 0x42])) === 'binary')
record('不含 NUL → text', attach.sniffKind('a.xyz', Buffer.from('hello')) === 'text')
record('扩展名优先：.png 即使全是 NUL 也算 image', attach.sniffKind('a.png', Buffer.alloc(16, 0)) === 'image')
record('行数统计：空文本 0 行', attach.countLines('') === 0)
record('行数统计：无换行算 1 行', attach.countLines('abc') === 1)
record('行数统计：三行', attach.countLines('a\nb\nc') === 3)
record('行数统计：末尾换行不多算一行（与 wc -l 一致）', attach.countLines('a\n') === 1 && attach.countLines('a\nb\n') === 2, `${attach.countLines('a\n')}/${attach.countLines('a\nb\n')}`)
record('体积格式化', attach.formatBytes(2048) === '2.0 KB', attach.formatBytes(2048))

/* ================= 2. 登记附件 ================= */
console.log('\n──────── 2. 登记附件（拷贝 / 原地引用 / 拒绝）────────')
const sessionId = 'sess-1'
const prepared = attach.prepareAttachments(
  [notesPath, insidePath, binaryPath, pngPath, unknownExtPath, customDelimPath],
  sessionId,
  { workspace }
)
const byName = Object.fromEntries(prepared.attachments.map((a) => [a.name, a]))

record('全部登记成功', prepared.attachments.length === 6, `实际 ${prepared.attachments.length}`)
record('零拒绝', prepared.errors.length === 0, JSON.stringify(prepared.errors))
record('外部文件被拷贝进应用数据目录', byName['notes.md']?.copied === true && byName['notes.md'].path.startsWith(appHome), byName['notes.md']?.path)
record('拷贝后原文件仍可读', fs.existsSync(byName['notes.md'].path))
record('拷贝内容与原文一致', fs.readFileSync(byName['notes.md'].path, 'utf8').includes('MARKER-A7'))
record('工作区内文件原地引用（不拷贝）', byName['inside.txt']?.copied === false && byName['inside.txt'].path === insidePath, byName['inside.txt']?.path)
record('sourcePath 保留原始路径', byName['notes.md']?.sourcePath === notesPath)
record('文本文件已内联', byName['notes.md']?.inlined === true && byName['notes.md'].inlineChars > 0)
record('文本文件记录了行数', byName['notes.md']?.lines === 3, `lines=${byName['notes.md']?.lines}`)
record('未知扩展名按内容判为文本并内联', byName['weird.xyz']?.kind === 'text' && byName['weird.xyz'].inlined === true)
record('二进制文件未内联且有说明', byName['blob.bin']?.inlined === false && byName['blob.bin'].note.includes('二进制'))
record('图片未内联并说明文本模型看不到像素', byName['pic.png']?.kind === 'image' && byName['pic.png'].note.includes('看不到像素'))

const longOne = attach.prepareAttachments([bigTextPath], sessionId, { workspace }).attachments[0]
record(
  `超长文本只内联前 ${attach.INLINE_PER_FILE_CHARS} 字符`,
  longOne.inlineChars === attach.INLINE_PER_FILE_CHARS,
  `inlineChars=${longOne.inlineChars}`
)
record('超长文本的说明写明被截断', longOne.note.includes('仅内联前') && longOne.note.includes('其余请用工具读取'), longOne.note)
record('超长文本记录的是**全文**行数', longOne.lines === BIG_LINES, `lines=${longOne.lines}（期望 ${BIG_LINES}）`)

const dup = attach.prepareAttachments([notesPath, notesPath], sessionId, { workspace })
record('同一路径重复提交会去重', dup.attachments.length === 1, `实际 ${dup.attachments.length}`)

const rejected = attach.prepareAttachments(
  [path.join(outside, 'not-exist.txt'), dirPath, hugePath, notesPath],
  sessionId,
  { workspace }
)
record('不存在的文件被拒绝', rejected.errors.some((e) => e.reason.includes('不存在')))
record('文件夹被拒绝并给出原因', rejected.errors.some((e) => e.reason.includes('文件夹')))
record('超过上限的文件被拒绝', rejected.errors.some((e) => e.reason.includes('过大')), JSON.stringify(rejected.errors.map((e) => e.reason)))
record('同批次里合法的文件照常登记', rejected.attachments.length === 1, `实际 ${rejected.attachments.length}`)
record('被拒绝的文件没有产生拷贝', !fs.existsSync(path.join(appHome, 'attachments', sessionId, '4-huge.dat')))

// 预算 600：mid-a（400 字符）内联后只剩 200，低于 MIN_INLINE_CHARS ⇒ mid-b 不再内联
const budgetLimited = attach.prepareAttachments([midAPath, midBPath], sessionId, {
  workspace,
  inlineTotalChars: 600
})
const budgetByName = Object.fromEntries(budgetLimited.attachments.map((a) => [a.name, a]))
record('预算够的文件正常内联', budgetByName['mid-a.txt'].inlined === true, `inlineChars=${budgetByName['mid-a.txt'].inlineChars}`)
record(
  '剩余预算太低时宁可不内联（不塞半截正文）',
  budgetByName['mid-b.txt'].inlined === false && budgetByName['mid-b.txt'].note.includes('预算已用完'),
  budgetByName['mid-b.txt'].note
)
record('未内联的文件 inlineChars 为 0', budgetByName['mid-b.txt'].inlineChars === 0)

/* ================= 3. 正文读取 ================= */
console.log('\n──────── 3. 读取内联正文 ────────')
const inlineText = attach.readInlineText(byName['notes.md'])
record('能读回内联正文', inlineText.includes('MARKER-A7'))
record('二进制文件读回空串', attach.readInlineText(byName['blob.bin']) === '')
const truncatedRead = attach.readInlineText(longOne)
record('读回的内联正文长度就是声明的长度', truncatedRead.length === longOne.inlineChars, `${truncatedRead.length}`)

/* ================= 4. 提示词拼装 ================= */
console.log('\n──────── 4. 提示词拼装 ────────')

const plain = attach.buildAttachmentPrompt('就这一句话', [])
record('没有附件时原样返回（既有行为不变）', plain === '就这一句话', JSON.stringify(plain.slice(0, 40)))

const withFiles = attach.buildAttachmentPrompt('帮我总结这些文件', [
  { attachment: byName['notes.md'], text: attach.readInlineText(byName['notes.md']) },
  { attachment: byName['blob.bin'], text: '' }
])
record('保留用户原话', withFiles.startsWith('帮我总结这些文件'))
record('声明了附件数量', withFiles.includes('本轮随消息提交了 2 个文件'))
record('列出了文件路径', withFiles.includes(byName['notes.md'].path) && withFiles.includes(byName['blob.bin'].path))
record('内联文件的正文被放进提示词', withFiles.includes('MARKER-A7'))
record('内联正文有明确分隔标记', withFiles.includes('<<< FILE 1: notes.md >>>') && withFiles.includes('<<< END FILE 1: notes.md >>>'))
record('未内联文件写明「不要凭空猜测」', withFiles.includes('不要凭空猜测'))
record('结尾要求先读文件再回答', withFiles.includes('请先据此了解文件内容'))

// 「读取命令示例」只对**文本**类未内联文件有意义（二进制给了也没法 Get-Content）
const bigNotInlined = attach.prepareAttachments([bigTextPath], sessionId, { workspace, inlineTotalChars: 100 }).attachments[0]
const textHintPrompt = attach.buildAttachmentPrompt('看大文件', [{ attachment: bigNotInlined, text: '' }])
record('文本类未内联文件给出 Get-Content 读取示例', textHintPrompt.includes('Get-Content -TotalCount 200'))
record('文本类未内联文件给出全文检索示例', textHintPrompt.includes('Select-String -Path'))
record('未内联的说明里带上全文规模', textHintPrompt.includes(`${BIG_LINES} 行`), textHintPrompt.split('\n').find((l) => l.includes('行')) ?? '')

const delimPrompt = attach.buildAttachmentPrompt('看文件', [
  { attachment: byName['delim.txt'], text: attach.readInlineText(byName['delim.txt']) }
])
const rawDelimCount = (delimPrompt.match(/<<< END FILE 1: x >>>/g) ?? []).length
record('正文里自带的同名分隔符被打散（不会混淆边界）', rawDelimCount === 0, `残留 ${rawDelimCount} 处`)
record('打散后仍保留原文可辨认性', delimPrompt.includes('后置'))

/* ================= 5. 清理 ================= */
console.log('\n──────── 5. 清理 ────────')
const dirOfSession = path.join(appHome, 'attachments', sessionId)
record('拷贝目录已建立', fs.existsSync(dirOfSession))
attach.cleanupSessionAttachments(sessionId)
record('清理会话后拷贝目录被删除', !fs.existsSync(dirOfSession))
record('原地引用的工作区文件不受清理影响', fs.existsSync(insidePath))

const removable = attach.prepareAttachments([notesPath], 'sess-2', { workspace }).attachments[0]
record('单文件删除成功', attach.removeAttachmentCopy(removable) && !fs.existsSync(removable.path))
record('原地引用的附件删除时不动原文件', attach.removeAttachmentCopy(byName['inside.txt']) && fs.existsSync(insidePath))

/* ================= 汇总 ================= */
try {
  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(appHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
}
process.exit(failed.length === 0 ? 0 : 1)
