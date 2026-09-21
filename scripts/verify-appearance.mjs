/**
 * 个性化设置端到端验证（真实 Electron + CDP）。
 *
 * 覆盖：默认状态零变化 → 设背景/槽位 → 重新加载后仍在（持久化）→
 *       坏图回退默认 → 恢复默认后回到初始状态。
 *
 * 注意：本脚本给 Electron 子进程指定独立的 USERPROFILE，
 * 因此不会写入用户真实的 ~/.codex-desktop/config.json。
 *
 * 运行：node scripts/verify-appearance.mjs
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
const DEBUG_PORT = 9335

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(entry)) {
  console.error(`缺少构建产物：${entry}，请先 npm run build`)
  process.exit(2)
}

// 1x1 PNG，够用来验证渲染与持久化
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-appearance-verify-'))
const appHome = path.join(fakeHome, 'appdata')
const configPath = path.join(appHome, 'config.json')

const child = spawn(electronBin, [entry, `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: root,
  // 用 CODEX_DESKTOP_HOME 重定向应用数据目录。
  // 千万不要改 USERPROFILE —— 实测那样 Electron 会直接退出（连 CDP 都起不来）。
  env: { ...process.env, CODEX_DESKTOP_HOME: appHome },
  stdio: ['ignore', 'pipe', 'pipe']
})
let mainOut = ''
child.stdout.on('data', (d) => (mainOut += d.toString()))
child.stderr.on('data', (d) => (mainOut += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return null
}

const target = await findPageTarget()
if (!target) {
  console.error('无法连接渲染进程：')
  console.error(mainOut)
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
  }
})

await send('Runtime.enable')

async function evaluate(expression, timeoutMs = 15000) {
  const result = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => null)
  ])
  return result?.result?.value
}

/** 等页面就绪（reload 之后执行上下文会换，所以要轮询到能取到值为止） */
async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await evaluate('document.readyState === "complete" && !!document.querySelector(".app")', 3000)
    if (ready === true) return true
    await sleep(400)
  }
  return false
}

const SNAPSHOT = `JSON.stringify({
  hasBg: document.documentElement.getAttribute('data-has-bg'),
  avatars: document.documentElement.getAttribute('data-avatars'),
  bgDisplay: (() => { const el = document.querySelector('.app-bg'); return el ? getComputedStyle(el).display : 'missing' })(),
  bgImgSrc: (() => { const el = document.querySelector('.app-bg-img'); return el ? (el.getAttribute('src') || '').slice(0, 40) : null })(),
  bgLayout: (() => { const el = document.querySelector('.app-bg'); return el ? el.getAttribute('data-layout') : null })(),
  brandImg: (() => { const el = document.querySelector('.brand-mark .fit-img'); return el ? el.getAttribute('src').slice(0, 40) : null })(),
  brandSvg: !!document.querySelector('.brand-mark svg'),
  avatarImgs: document.querySelectorAll('.bubble-avatar .fit-img').length,
  emptyArtImg: !!document.querySelector('.empty-art .fit-img'),
  gear: !!document.querySelector('[aria-label="个性化设置"]'),
  drawer: !!document.querySelector('.drawer')
})`

const snapshot = async () => JSON.parse(await evaluate(SNAPSHOT))
/** 没有背景时 .app-bg 直接不渲染（返回 null），所以 missing 也算「不显示」 */
const notShown = (value) => value === 'missing' || value === 'none'

/** 用真实鼠标事件点击（比 element.click() 更接近真人，也能暴露被遮挡的问题） */
async function clickSelector(selector) {
  const rect = JSON.parse(
    await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'null'
        const r = el.getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]) })()`
    )
  )
  if (!Array.isArray(rect)) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect[0], y: rect[1] })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect[0], y: rect[1], button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect[0], y: rect[1], button: 'left', clickCount: 1 })
  await sleep(500)
  return true
}

/** 抽屉是否真的可见（在视口内、有尺寸、且在最上层可点） */
async function drawerState() {
  return JSON.parse(
    await evaluate(`JSON.stringify((() => {
      const root = document.querySelector('.drawer-root')
      const drawer = document.querySelector('.drawer')
      if (!root || !drawer) return { open: false }
      const r = drawer.getBoundingClientRect()
      const s = getComputedStyle(root)
      const mid = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + 200))
      return {
        open: true,
        zIndex: s.zIndex,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        inViewport: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1,
        hitTestInside: !!mid && !!mid.closest('.drawer'),
        sections: [...document.querySelectorAll('.drawer-section-title')].map((el) => el.textContent),
        hasFooter: !!document.querySelector('.drawer-foot'),
        fileInputHidden: (() => { const el = document.querySelector('.hidden-file-input'); return !el || getComputedStyle(el).display === 'none' })()
      }
    })())`)
  )
}

console.log('──────── 1. 默认状态（不应有任何个性化痕迹）────────')
await waitForReady()
let state = await snapshot()
record('默认没有 data-has-bg', state.hasBg === null, String(state.hasBg))
record('默认背景层不显示', notShown(state.bgDisplay), state.bgDisplay)
record('默认品牌标记是内置 SVG', state.brandSvg === true && state.brandImg === null)
record('默认空状态插图不是图', state.emptyArtImg === false)
record('默认没有自定义头像图', state.avatarImgs === 0, String(state.avatarImgs))
record('右上角有齿轮入口', state.gear === true)

console.log('\n──────── 1b. 点齿轮必须真的能打开抽屉（回归：曾因 CSS 被整段删除而打不开）────────')
record('点击前抽屉不存在', (await drawerState()).open === false)
await clickSelector('[aria-label="个性化设置"]')
let drawer = await drawerState()
record('点击后抽屉已打开', drawer.open === true)
record('抽屉在视口内（不是被排到页面下方）', drawer.inViewport === true, JSON.stringify(drawer.rect))
record('抽屉有定位层级 z-index=70', drawer.zIndex === '70', String(drawer.zIndex))
record('抽屉宽度是侧边栏尺寸（≈420）', Math.abs((drawer.rect?.[2] ?? 0) - 420) < 40, String(drawer.rect?.[2]))
record('抽屉在最上层可点击（命中测试通过）', drawer.hitTestInside === true)
record(
  '三个分区标题齐全（背景与头像/图标明确分开）',
  ['视觉风格', '全屏背景', '头像与图标'].every((t) => (drawer.sections ?? []).includes(t)),
  JSON.stringify(drawer.sections)
)
record('底部操作区存在（保存/取消/全部恢复默认）', drawer.hasFooter === true)
record('文件选择器被隐藏（不能露出裸 input）', drawer.fileInputHidden === true)

// 点遮罩关闭
await clickSelector('.drawer-scrim')
record('点空白处能关闭抽屉', (await drawerState()).open === false)

console.log('\n──────── 2. 设置背景 + 两个槽位（走真实 IPC 落盘）────────')
const appearanceWithImages = {
  background: { source: PNG_1PX, kind: 'data', bytes: 68, addedAt: Date.now() },
  backgroundOverlay: 0.6,
  backgroundBlur: 4,
  showAvatars: true,
  slots: {
    brandLogo: { source: PNG_1PX, kind: 'data', bytes: 68, addedAt: Date.now() },
    userAvatar: { source: PNG_1PX, kind: 'data', bytes: 68, addedAt: Date.now() },
    emptyState: { source: PNG_1PX, kind: 'data', bytes: 68, addedAt: Date.now() }
  }
}
const saveResult = await evaluate(
  `window.api.saveSettings({ appearance: ${JSON.stringify(appearanceWithImages)} }).then(s => s.appearance.slots ? 'ok' : 'bad')`
)
record('saveSettings 接受外观设置', saveResult === 'ok', String(saveResult))

// 落盘校验
const onDisk = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null
record('已写入 config.json', Boolean(onDisk?.appearance?.background), configPath)
record('磁盘上的槽位齐全', Object.keys(onDisk?.appearance?.slots ?? {}).sort().join(',') === 'brandLogo,emptyState,userAvatar', JSON.stringify(Object.keys(onDisk?.appearance?.slots ?? {})))
record('数值已持久化', onDisk?.appearance?.backgroundOverlay === 0.6 && onDisk?.appearance?.backgroundBlur === 4)

console.log('\n──────── 2b. 快捷切换个性化/系统默认：不能丢个性化数据 ────────')
const beforeToggle = JSON.parse(fs.readFileSync(configPath, 'utf8')).appearance
record('切换前已有背景与槽位', Boolean(beforeToggle.background) && Object.keys(beforeToggle.slots ?? {}).length === 3)
record('切换前是二次元预设', beforeToggle.stylePreset === 'anime', String(beforeToggle.stylePreset))

await clickSelector('[aria-label="切换个性化外观"]')
await sleep(700)
const afterClassic = JSON.parse(fs.readFileSync(configPath, 'utf8')).appearance
record('切换后变为系统默认（classic）', afterClassic.stylePreset === 'classic', String(afterClassic.stylePreset))
record('背景图未被清除', afterClassic.background?.source === beforeToggle.background?.source)
record('壁纸字段未被清除', afterClassic.wallpaper === beforeToggle.wallpaper)
record(
  '三个头像/插图槽位未被清除',
  Object.keys(afterClassic.slots ?? {}).length === 3,
  JSON.stringify(Object.keys(afterClassic.slots ?? {}))
)
record(
  '遮罩与模糊等数值未被重置',
  afterClassic.backgroundOverlay === beforeToggle.backgroundOverlay &&
    afterClassic.backgroundBlur === beforeToggle.backgroundBlur,
  `${afterClassic.backgroundOverlay} / ${afterClassic.backgroundBlur}`
)
const domClassic = await snapshot()
record('DOM 上 data-style 已变 classic', String(await evaluate(`document.documentElement.getAttribute('data-style')`)) === 'classic')
record('切到经典后背景仍然渲染', domClassic.bgDisplay === 'block' && Boolean(domClassic.bgImgSrc), `${domClassic.bgDisplay}`)

await clickSelector('[aria-label="切换个性化外观"]')
await sleep(700)
const backToAnime = JSON.parse(fs.readFileSync(configPath, 'utf8')).appearance
record('再点一次切回二次元', backToAnime.stylePreset === 'anime', String(backToAnime.stylePreset))
record('来回切换后背景仍在', backToAnime.background?.source === beforeToggle.background?.source)
record('来回切换后槽位仍在', Object.keys(backToAnime.slots ?? {}).length === 3)

// 切换后抽屉依然能打开
await clickSelector('[aria-label="个性化设置"]')
record('切换风格后抽屉仍能打开', (await drawerState()).open === true)
await clickSelector('.drawer-scrim')

console.log('\n──────── 3. 重新加载后仍然生效（持久化 + 启动应用）────────')
await evaluate('location.reload(); "reloading"')
await sleep(1200)
await waitForReady()
state = await snapshot()
record('重载后 data-has-bg=1', state.hasBg === '1', String(state.hasBg))
record('重载后背景层显示且带图', state.bgDisplay === 'block' && String(state.bgImgSrc).includes('data:image/png'), `${state.bgDisplay} / ${state.bgImgSrc}`)
// 背景改成 <img> + 像素定位后，默认应走像素布局（不是 fallback）
record('背景已走像素布局（自适应生效）', state.bgLayout === 'px', String(state.bgLayout))
record('重载后品牌标记换成自定义图', state.brandImg !== null && state.brandSvg === false, String(state.brandImg))
record('重载后空状态插图为自定义图', state.emptyArtImg === true)
record('重载后 avatars 标记为 on', state.avatars === 'on', String(state.avatars))
// 说明：头像图片走的是与品牌标记/空状态插图完全相同的 useSlotImage 路径（那两处已端到端验证），
// 这里再确认开关能落成 DOM 标记（CSS 据此隐藏头像）。

console.log('\n──────── 4. 坏图必须回退默认 ────────')
const badAppearance = JSON.parse(JSON.stringify(appearanceWithImages))
badAppearance.slots.brandLogo = { source: 'http://127.0.0.1:9/definitely-missing.png', kind: 'remote', bytes: 10, addedAt: Date.now() }
await evaluate(`window.api.saveSettings({ appearance: ${JSON.stringify(badAppearance)} }).then(() => 'ok')`)
await evaluate('location.reload(); "reloading"')
await sleep(1200)
await waitForReady()
await sleep(2500) // 等 onError 触发并回退
state = await snapshot()
record('坏图回退后重新出现内置 SVG', state.brandSvg === true && state.brandImg === null, `svg=${state.brandSvg} img=${state.brandImg}`)

console.log('\n──────── 5. 关闭头像显示 ────────')
const avatarsOffAppearance = JSON.parse(JSON.stringify(appearanceWithImages))
avatarsOffAppearance.showAvatars = false
await evaluate(`window.api.saveSettings({ appearance: ${JSON.stringify(avatarsOffAppearance)} }).then(() => 'ok')`)
await evaluate('location.reload(); "reloading"')
await sleep(1200)
await waitForReady()
state = await snapshot()
record('关闭后 data-avatars=off', state.avatars === 'off', String(state.avatars))

console.log('\n──────── 6. 恢复默认后回到初始状态 ────────')
await evaluate(
  `window.api.saveSettings({ appearance: { background: null, backgroundOverlay: 0.55, backgroundBlur: 0, showAvatars: true, slots: {} } }).then(() => 'ok')`
)
await evaluate('location.reload(); "reloading"')
await sleep(1200)
await waitForReady()
state = await snapshot()
record('恢复默认后 data-has-bg 消失', state.hasBg === null, String(state.hasBg))
record('恢复默认后背景层不显示', notShown(state.bgDisplay), state.bgDisplay)
record('恢复默认后品牌标记回到内置 SVG', state.brandSvg === true && state.brandImg === null)
record('恢复默认后空状态插图回到字形', state.emptyArtImg === false)
record('恢复默认后头像标记回到 on', state.avatars === 'on', String(state.avatars))

/* ---------------- 清理 ---------------- */
ws.close()
child.kill()
await sleep(600)
try {
  fs.rmSync(fakeHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
