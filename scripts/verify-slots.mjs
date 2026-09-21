/**
 * 头像/图标类图片的「必须留在框架内」验证。
 *
 * 这一组断言是为了防住一个真实事故：重写 appearance.css 时把槽位图片的样式整段删掉，
 * 于是 width/height:100% 与 object-fit:cover 失效，图片按**原始尺寸**渲染
 * （实测 800×600 的图塞进 30×30 的框），父容器 overflow 又是 visible，
 * 整张图溢出铺满屏幕 —— 用户看到的是「头像变成了全屏背景」。
 *
 * 覆盖：
 *   1. 槽位图渲染尺寸 == 框架尺寸（不是原始尺寸），cover 居中，父容器 overflow:hidden
 *   2. 槽位图绝不触发全屏背景层（data-has-bg 必须为空，.app-bg 必须不存在）
 *   3. 裁剪参数生效：缩放后图片大于框架但被裁住
 *   4. 重置裁剪后回到 cover
 *
 * 运行：node scripts/verify-slots.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const entry = path.join(root, 'out', 'main', 'index.js')
const PORT = 9371

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

// 800×600：尺寸差异极大，一旦「按原始尺寸渲染」立刻暴露
const BIG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#3366ff"/></svg>')

const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-slot-verify-'))
const configPath = path.join(appHome, 'config.json')

function writeConfig(slots) {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      apiKey: 'sk-slot',
      appearance: {
        background: null,
        wallpaper: null,
        backgroundOverlay: 0.22,
        backgroundBlur: 0,
        showAvatars: true,
        stylePreset: 'anime',
        slots
      }
    }),
    'utf8'
  )
}

const slot = (extra = {}) => ({ source: BIG, kind: 'data', bytes: 100, addedAt: 1, ...extra })
writeConfig({ brandLogo: slot(), emptyState: slot() })

const child = spawn(electronBin, [entry, `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env: { ...process.env, CODEX_DESKTOP_HOME: appHome },
  stdio: ['ignore', 'pipe', 'pipe']
})
let mainOut = ''
child.stdout.on('data', (d) => (mainOut += d.toString()))
child.stderr.on('data', (d) => (mainOut += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* wait */
    }
    await sleep(500)
  }
  return null
}

const page = await findTarget()
if (!page) {
  console.error('无法连接渲染进程：')
  console.error(mainOut)
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
await send('Runtime.enable')
await sleep(2800)

const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value

/** 量一对「框架 / 框架内图片」的几何 */
const GEOMETRY = `JSON.stringify((() => {
  const probe = (frameSel) => {
    const outer = document.querySelector(frameSel)
    // 真正负责裁剪的是内层 .fit-frame（inset:0，等于外框的内容盒）；
    // data-mode / overflow 都挂在它身上，别拿外框当参照（外框含边框，尺寸会差 2px）
    const frame = outer ? outer.querySelector('.fit-frame') : null
    const img = frame ? frame.querySelector('.fit-img') : null
    if (!outer || !frame || !img) return { frameSel, missing: true }
    const or = outer.getBoundingClientRect()
    const fr = frame.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    const imgStyle = getComputedStyle(img)
    const frameStyle = getComputedStyle(frame)
    return {
      frameSel,
      frame: [Math.round(fr.width), Math.round(fr.height)],
      outer: [Math.round(or.width), Math.round(or.height)],
      img: [Math.round(ir.width), Math.round(ir.height)],
      natural: [img.naturalWidth, img.naturalHeight],
      objectFit: imgStyle.objectFit,
      objectPosition: imgStyle.objectPosition,
      frameOverflow: frameStyle.overflow,
      mode: frame.getAttribute('data-mode'),
      // 图片是否超出「外层可见框」（含边框）—— 这才是用户看到的边界
      overflowsOuter: ir.width > or.width + 0.5 || ir.height > or.height + 0.5,
      coversViewport: ir.width >= window.innerWidth - 2 && ir.height >= window.innerHeight - 2,
      centerOffset: [Math.round(ir.x + ir.width / 2 - (fr.x + fr.width / 2)), Math.round(ir.y + ir.height / 2 - (fr.y + fr.height / 2))]
    }
  }
  return {
    viewport: [window.innerWidth, window.innerHeight],
    hasBg: document.documentElement.getAttribute('data-has-bg'),
    bgLayer: !!document.querySelector('.app-bg'),
    brand: probe('.brand-mark'),
    empty: probe('.empty-art'),
    // 全页扫描：任何图片都不该铺满视口
    anyFullscreenImg: [...document.querySelectorAll('img')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2
    }).length
  }
})())`

const geo = async () => JSON.parse(await evaluate(GEOMETRY))

console.log('──────── 1. 槽位图必须留在框架内 ────────')
let g = await geo()
record('品牌标记：图片尺寸 == 框架尺寸（不是原始 800×600）', !g.brand.missing && g.brand.img[0] === g.brand.frame[0] && g.brand.img[1] === g.brand.frame[1], `frame=${JSON.stringify(g.brand.frame)} img=${JSON.stringify(g.brand.img)} natural=${JSON.stringify(g.brand.natural)}`)
record('品牌标记：object-fit 为 cover（不拉伸）', g.brand.objectFit === 'cover', String(g.brand.objectFit))
record('品牌标记：居中显示', g.brand.objectPosition === '50% 50%' || g.brand.objectPosition === 'center', String(g.brand.objectPosition))
record('品牌标记：框架裁剪溢出', g.brand.frameOverflow === 'hidden', String(g.brand.frameOverflow))
record('品牌标记：未超出外层可见框', g.brand.overflowsOuter === false, `img=${JSON.stringify(g.brand.img)} outer=${JSON.stringify(g.brand.outer)}`)
record('品牌标记：未铺满视口', g.brand.coversViewport === false)

record('空状态插图：图片尺寸 == 裁剪框尺寸', !g.empty.missing && g.empty.img[0] === g.empty.frame[0], `frame=${JSON.stringify(g.empty.frame)} img=${JSON.stringify(g.empty.img)}`)
record('空状态插图：未超出外层可见框', g.empty.overflowsOuter === false, `img=${JSON.stringify(g.empty.img)} outer=${JSON.stringify(g.empty.outer)}`)
record('空状态插图：object-fit 为 cover', g.empty.objectFit === 'cover', String(g.empty.objectFit))
record('空状态插图：未铺满视口', g.empty.coversViewport === false)

console.log('\n──────── 2. 槽位图绝不能触发全屏背景 ────────')
record('data-has-bg 为空（槽位不算背景）', g.hasBg === null, String(g.hasBg))
record('背景层 .app-bg 不存在', g.bgLayer === false, String(g.bgLayer))
record('页面上没有任何铺满视口的图片', g.anyFullscreenImg === 0, `找到 ${g.anyFullscreenImg} 个`)

console.log('\n──────── 3. 裁剪参数生效（缩放后仍被裁住）────────')
writeConfig({ brandLogo: slot({ transform: { zoom: 2, offsetX: 0.15, offsetY: -0.1, crop: null } }), emptyState: slot() })
await evaluate('location.reload(); "r"')
await sleep(1200)
for (let i = 0; i < 25; i++) {
  const ready = await evaluate(`(() => { const f = document.querySelector('.brand-mark .fit-frame'); return !!f && f.getAttribute('data-mode') === 'custom' })()`, 3000)
  if (ready === true) break
  await sleep(300)
}
await sleep(300)
g = await geo()
record('自定义裁剪时切到像素模式', g.brand.mode === 'custom', String(g.brand.mode))
record('缩放 200% 后图片确实大于框架', g.brand.img[0] > g.brand.frame[0] * 1.5, `frame=${g.brand.frame[0]} img=${g.brand.img[0]}`)
record('放大后框架仍裁剪溢出（视觉上被裁住）', g.brand.frameOverflow === 'hidden', String(g.brand.frameOverflow))
record('放大后仍未铺满视口', g.brand.coversViewport === false, `${g.brand.img[0]}x${g.brand.img[1]} vs viewport ${g.viewport[0]}x${g.viewport[1]}`)
record('平移生效（中心相对框架偏移）', Math.abs(g.brand.centerOffset[0]) > 0.5 || Math.abs(g.brand.centerOffset[1]) > 0.5, JSON.stringify(g.brand.centerOffset))
record('自定义裁剪时依然没有背景层', (await geo()).bgLayer === false)

console.log('\n──────── 4. 重置裁剪后回到默认 cover ────────')
writeConfig({ brandLogo: slot(), emptyState: slot() })
await evaluate('location.reload(); "r"')
await sleep(1200)
for (let i = 0; i < 25; i++) {
  const ready = await evaluate(`(() => { const f = document.querySelector('.brand-mark .fit-frame'); return !!f && f.getAttribute('data-mode') === 'cover' })()`, 3000)
  if (ready === true) break
  await sleep(300)
}
g = await geo()
record('重置后回到 cover 模式', g.brand.mode === 'cover', String(g.brand.mode))
record('重置后图片尺寸再次等于框架尺寸', g.brand.img[0] === g.brand.frame[0], `frame=${g.brand.frame[0]} img=${g.brand.img[0]}`)

/* ---------------- 清理 ---------------- */
ws.close()
child.kill()
await sleep(600)
try {
  fs.rmSync(appHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
