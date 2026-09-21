/**
 * 背景可见性 + 自适应/编辑的端到端验证。
 *
 * 最关键的一项：**采样真实像素**。用纯红背景截图，再在页面里把截图画到 canvas 上取色，
 * 直接证明「背景确实透出来了」，而不是只看 CSS 属性。
 *
 * 覆盖：
 *  1. 面板不再是几乎不透明（alpha ≤ 0.5）、对话区透明
 *  2. 纯红背景在侧栏/对话区的像素上确实呈红（R 明显大于 G/B）
 *  3. 默认自适应：cover 铺满、宽高比不变、不露白
 *  4. 缩放 200% 生效；框选后选区铺满容器
 *  5. 窗口尺寸变化后背景自动跟随（仍然铺满）
 *  6. 恢复默认回到 cover
 *
 * 运行：node scripts/verify-background.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const entry = path.join(root, 'out', 'main', 'index.js')
const PORT = 9341

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

// 纯红 SVG 背景：最容易用像素判断是否可见
const RED_SVG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#ff0000"/></svg>'
  )

const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bg-verify-'))
fs.mkdirSync(appHome, { recursive: true })
fs.writeFileSync(
  path.join(appHome, 'config.json'),
  JSON.stringify({
    apiKey: 'sk-bg',
    theme: 'dark',
    appearance: {
      background: { source: RED_SVG, kind: 'data', bytes: 200, addedAt: Date.now() },
      wallpaper: null,
      backgroundOverlay: 0.22,
      backgroundBlur: 0,
      showAvatars: true,
      stylePreset: 'anime',
      slots: {}
    }
  }),
  'utf8'
)

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
await sleep(2600)

const evaluate = async (expression, timeoutMs = 20000) => {
  const result = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => null)
  ])
  return result?.result?.value
}

/** 在页面里把截图绘制到 canvas 并采样若干点（坐标为 CSS 像素） */
async function samplePixels(points) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data
  if (!data) return null
  const expression = `(async () => {
    const img = new Image()
    img.src = 'data:image/png;base64,${data}'
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const kx = img.naturalWidth / window.innerWidth
    const ky = img.naturalHeight / window.innerHeight
    const pts = ${JSON.stringify(points)}
    return pts.map(([x, y]) => {
      const d = ctx.getImageData(Math.round(x * kx), Math.round(y * ky), 1, 1).data
      return [d[0], d[1], d[2]]
    })
  })()`
  return evaluate(expression)
}

console.log('──────── 1. 根因修复：面板不再几乎不透明 ────────')
const styles = JSON.parse(
  await evaluate(`JSON.stringify((() => {
    const get = (sel) => { const el = document.querySelector(sel); if (!el) return null
      const s = getComputedStyle(el); return { bg: s.backgroundColor, backdrop: s.backdropFilter || s.webkitBackdropFilter } }
    return {
      hasBg: document.documentElement.getAttribute('data-has-bg'),
      style: document.documentElement.getAttribute('data-style'),
      sidebar: get('.sidebar'), statusbar: get('.statusbar'), composer: get('.composer'),
      rightpanel: get('.rightpanel'), chat: get('.chat'), main: get('.main'),
      overlayOpacity: getComputedStyle(document.querySelector('.app-bg-overlay')).opacity,
      bgImgExists: !!document.querySelector('.app-bg-img'),
      bgImgSrc: (document.querySelector('.app-bg-img')||{}).src ? document.querySelector('.app-bg-img').src.slice(0,30) : null
    }
  })())`)
)

const alphaOf = (color) => {
  const m = /\/\s*([\d.]+)\)/.exec(color) || /rgba?\([^)]*,\s*([\d.]+)\)/.exec(color)
  if (m) return Number(m[1])
  return color.startsWith('rgb(') ? 1 : 1
}

record('data-has-bg=1', styles.hasBg === '1', String(styles.hasBg))
record('二次元风格已启用', styles.style === 'anime', String(styles.style))
record('背景 <img> 已渲染', styles.bgImgExists === true, String(styles.bgImgSrc))
record('侧栏不再是几乎不透明', alphaOf(styles.sidebar.bg) <= 0.5, `alpha=${alphaOf(styles.sidebar.bg)} (${styles.sidebar.bg})`)
record('状态栏不再是几乎不透明', alphaOf(styles.statusbar.bg) <= 0.5, `alpha=${alphaOf(styles.statusbar.bg)}`)
record('右侧面板不再是几乎不透明', alphaOf(styles.rightpanel.bg) <= 0.5, `alpha=${alphaOf(styles.rightpanel.bg)}`)
record('输入区不再是几乎不透明', alphaOf(styles.composer.bg) <= 0.5, `alpha=${alphaOf(styles.composer.bg)}`)
record('对话区完全透明（壁纸是主体）', styles.chat.bg === 'rgba(0, 0, 0, 0)', styles.chat.bg)
record('面板有毛玻璃模糊', String(styles.sidebar.backdrop).includes('blur'), String(styles.sidebar.backdrop))
record('遮罩强度按设置生效', Number(styles.overlayOpacity) === 0.22, styles.overlayOpacity)

console.log('\n──────── 2. 像素级证明：红色背景确实透出来了 ────────')
const pixels = await samplePixels([
  [110, 520], // 侧栏
  [760, 520], // 对话区
  [1300, 520] // 右侧面板
])
if (!pixels) {
  record('截图采样成功', false, 'captureScreenshot 无返回')
} else {
  pixels.forEach(([r, g, b], index) => {
    const where = ['侧栏', '对话区', '右侧面板'][index]
    const reddish = r > 90 && r > g * 1.35 && r > b * 1.35
    record(`${where}像素呈红色（背景透出）`, reddish, `rgb(${r}, ${g}, ${b})`)
  })
}

console.log('\n──────── 3. 默认自适应（cover 铺满 / 不变形 / 不露白）────────')
const geometry = async () =>
  JSON.parse(
    await evaluate(`JSON.stringify((() => {
      const box = document.querySelector('.app-bg'); const img = document.querySelector('.app-bg-img')
      if (!box || !img) return null
      const ib = img.getBoundingClientRect()
      return { cw: box.clientWidth, ch: box.clientHeight, iw: ib.width, ih: ib.height,
               natural: [img.naturalWidth, img.naturalHeight],
               left: ib.left - box.getBoundingClientRect().left, top: ib.top - box.getBoundingClientRect().top }
    })())`)
  )

let geo = await geometry()
record('铺满容器（不露白）', geo.iw >= geo.cw - 1 && geo.ih >= geo.ch - 1, `${geo.iw.toFixed(0)}x${geo.ih.toFixed(0)} vs ${geo.cw}x${geo.ch}`)
const ratio = geo.natural[0] / geo.natural[1]
record(
  '保持图片宽高比（不拉伸）',
  Math.abs(geo.iw / geo.ih - ratio) < 0.01,
  `${(geo.iw / geo.ih).toFixed(4)} vs ${ratio.toFixed(4)}`
)
record(
  '居中',
  Math.abs(geo.left + geo.iw / 2 - geo.cw / 2) < 2 && Math.abs(geo.top + geo.ih / 2 - geo.ch / 2) < 2,
  `left=${geo.left.toFixed(0)} top=${geo.top.toFixed(0)}`
)

const setTransform = async (transform) => {
  await evaluate(
    `window.api.saveSettings({ appearance: { background: { source: ${JSON.stringify(RED_SVG)}, kind: 'data', bytes: 200, addedAt: 1, transform: ${JSON.stringify(transform)} } } }).then(() => 'ok')`
  )
  await evaluate('location.reload(); "r"')
  await sleep(1000)
  // 等像素布局真正生效再断言（data-layout 是组件专门暴露的状态标记），
  // 只等元素出现会撞上「已挂载但还没量到尺寸」的中间态，导致偶发失败
  for (let i = 0; i < 30; i++) {
    const ready = await evaluate(
      `(() => { const el = document.querySelector('.app-bg'); return !!el && el.getAttribute('data-layout') === 'px' })()`,
      3000
    )
    if (ready === true) break
    await sleep(300)
  }
  await sleep(300)
}

console.log('\n──────── 4. 缩放与框选 ────────')
const baseGeo = geo
await setTransform({ zoom: 2, offsetX: 0, offsetY: 0, crop: null })
geo = await geometry()
record('缩放 200% 生效', Math.abs(geo.iw - baseGeo.iw * 2) < 3, `${geo.iw.toFixed(0)} vs ${(baseGeo.iw * 2).toFixed(0)}`)
record('缩放后仍不变形', Math.abs(geo.iw / geo.ih - ratio) < 0.01)

await setTransform({ zoom: 1, offsetX: 0.2, offsetY: 0, crop: null })
const panned = await geometry()
record('平移生效', panned.left > geo.left + 50, `left ${geo.left.toFixed(0)} → ${panned.left.toFixed(0)}`)

await setTransform({ zoom: 1, offsetX: 0, offsetY: 0, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
const cropped = await geometry()
record(
  '框选后选区铺满容器',
  cropped.iw >= cropped.cw - 1 && cropped.ih >= cropped.ch - 1,
  `${cropped.iw.toFixed(0)}x${cropped.ih.toFixed(0)} vs ${cropped.cw}x${cropped.ch}`
)
record('框选后仍不变形', Math.abs(cropped.iw / cropped.ih - ratio) < 0.01)

console.log('\n──────── 5. 窗口尺寸变化时自动跟随 ────────')
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false })
await sleep(900)
const resized = await geometry()
record('容器尺寸已跟随变化', resized.cw !== baseGeo.cw, `${baseGeo.cw} → ${resized.cw}`)
record(
  '尺寸变化后仍然铺满（不露白）',
  resized.iw >= resized.cw - 1 && resized.ih >= resized.ch - 1,
  `${resized.iw.toFixed(0)}x${resized.ih.toFixed(0)} vs ${resized.cw}x${resized.ch}`
)
await send('Emulation.clearDeviceMetricsOverride')
await sleep(600)

console.log('\n──────── 6. 重置回自适应 ────────')
await setTransform({ zoom: 1, offsetX: 0, offsetY: 0, crop: null })
const reset = await geometry()
record(
  '重置后回到 cover 居中',
  Math.abs(reset.iw - baseGeo.iw) < 3 && Math.abs(reset.left - baseGeo.left) < 2,
  `${reset.iw.toFixed(0)}x${reset.ih.toFixed(0)}`
)

console.log('\n──────── 7. 参数持久化 ────────')
// 先设一个非默认参数再读盘：全默认参数按设计不会落冗余字段
await setTransform({ zoom: 1.5, offsetX: 0.1, offsetY: -0.05, crop: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } })
const onDisk = JSON.parse(fs.readFileSync(path.join(appHome, 'config.json'), 'utf8'))
const savedTransform = onDisk.appearance?.background?.transform
record('transform 已持久化到配置', Boolean(savedTransform), JSON.stringify(savedTransform))
record(
  '缩放/平移/框选数值都写入正确',
  savedTransform?.zoom === 1.5 && savedTransform?.offsetX === 0.1 && savedTransform?.crop?.w === 0.6,
  JSON.stringify(savedTransform)
)
const afterReload = await geometry()
record(
  '重载后参数仍然生效（不是回到 cover）',
  afterReload.iw > resized.iw * 1.2,
  `${afterReload.iw.toFixed(0)} vs cover≈${resized.iw.toFixed(0)}`
)

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
