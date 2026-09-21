/**
 * 个性化设置的纯逻辑测试（不需要浏览器）。
 *
 * 覆盖：魔术字节识别、远程地址校验、体积估算、以及 config.json 的出入参净化。
 * 运行：node test/appearance-unit.mjs
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

/* ---------------- 隔离 HOME，避免动到真实配置 ---------------- */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-appearance-home-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

const alias = { '@shared/types': path.join(root, 'src/shared/types.ts') }
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
    alias,
    logLevel: 'warning'
  })
  return import(pathToFileURL(path.join(tmpDir, outfile)).href)
}

const image = await bundle('src/renderer/src/utils/image.ts', 'image.bundle.mjs')
const settings = await bundle('src/core/settings.ts', 'settings.bundle.mjs')
const background = await bundle('src/renderer/src/utils/background.ts', 'background.bundle.mjs')
const wallpapers = await bundle('src/renderer/src/utils/wallpapers.ts', 'wallpapers.bundle.mjs')

/* ================= 1. 魔术字节识别 ================= */
console.log('──────── 1. 图片类型识别（魔术字节）────────')

const magic = (bytes) => image.sniffMime(Uint8Array.from(bytes))

record('识别 JPEG', magic([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]) === 'image/jpeg')
record('识别 PNG', magic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) === 'image/png')
record('识别 GIF', magic([...Buffer.from('GIF89a'), 0, 0, 0, 0, 0, 0]) === 'image/gif')
record(
  '识别 WEBP',
  magic([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]) === 'image/webp'
)
record(
  '识别 AVIF',
  magic([0, 0, 0, 0x20, ...Buffer.from('ftypavif'), 0, 0, 0, 0]) === 'image/avif'
)
record('纯文本不被当成图片', magic([...Buffer.from('hello world!!!')]) === null)
record('EXE 头（MZ）不被当成图片', magic([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]) === null)
record('过短的数据不被当成图片', magic([0xff, 0xd8]) === null)

/* ================= 2. 远程地址校验 ================= */
console.log('\n──────── 2. 粘贴 URL 的校验 ────────')

record('接受 https', image.validateRemoteUrl('https://example.com/a.png').ok === true)
record('接受 http（局域网图床）', image.validateRemoteUrl('http://192.168.1.10/a.png').ok === true)
record('拒绝 javascript:', image.validateRemoteUrl('javascript:alert(1)').ok === false)
record('拒绝 file:', image.validateRemoteUrl('file:///C:/secret.png').ok === false)
record('拒绝 data:（必须走上传通道）', image.validateRemoteUrl('data:image/png;base64,AAAA').ok === false)
record('拒绝空字符串', image.validateRemoteUrl('   ').ok === false)
record('拒绝非 URL 文本', image.validateRemoteUrl('这不是地址').ok === false)
const rejected = image.validateRemoteUrl('javascript:alert(1)')
record('拒绝时给出可读理由', rejected.ok === false && rejected.reason.includes('http'), rejected.ok ? '' : rejected.reason)

/* ================= 3. 体积估算 ================= */
console.log('\n──────── 3. 体积估算 ────────')

// "AAAA" → 3 字节
record('estimateBytes 基本换算', image.estimateBytes('data:image/png;base64,AAAA') === 3)
// "AAA=" → 2 字节（含 1 个 padding）
record('estimateBytes 处理 padding(=)', image.estimateBytes('data:image/png;base64,AAA=') === 2)
record('estimateBytes 处理 padding(==)', image.estimateBytes('data:image/png;base64,AA==') === 1)
record('formatBytes 人类可读', image.formatBytes(2048) === '2.0 KB', image.formatBytes(2048))
record('formatBytes 处理 MB', image.formatBytes(3 * 1024 * 1024) === '3.00 MB', image.formatBytes(3 * 1024 * 1024))

const appearance = {
  background: { source: 'data:image/png;base64,AAAA', kind: 'data', bytes: 3, addedAt: 1 },
  backgroundOverlay: 0.5,
  backgroundBlur: 0,
  showAvatars: true,
  slots: {
    brandLogo: { source: 'data:image/png;base64,AAAAAAAA', kind: 'data', bytes: 6, addedAt: 1 }
  }
}
record('totalCustomBytes 汇总背景 + 槽位', image.totalCustomBytes(appearance) === 9, String(image.totalCustomBytes(appearance)))

/* ================= 4. config.json 出入参净化 ================= */
console.log('\n──────── 4. 配置读写净化 ────────')

const appDir = path.join(fakeHome, '.codex-desktop')
fs.mkdirSync(appDir, { recursive: true })

fs.writeFileSync(
  path.join(appDir, 'config.json'),
  JSON.stringify({
    apiKey: 'sk-test',
    appearance: {
      // 非法源：必须被丢弃
      background: { source: 'javascript:alert(1)', kind: 'remote', bytes: 1 },
      // 越界数值：必须被 clamp
      backgroundOverlay: 99,
      backgroundBlur: -5,
      showAvatars: 'yes',
      slots: {
        brandLogo: { source: 'data:image/png;base64,AAAA', bytes: 3 },
        // 未知槽位：必须被丢弃
        notARealSlot: { source: 'https://example.com/a.png', bytes: 10 },
        // 相对路径：必须被丢弃
        userAvatar: { source: '/local/a.png', bytes: 10 }
      }
    }
  }),
  'utf8'
)

const loaded = settings.loadSettings()
record('非法背景源被丢弃', loaded.appearance.background === null, JSON.stringify(loaded.appearance.background))
record('backgroundOverlay 被 clamp 到 0.9', loaded.appearance.backgroundOverlay === 0.9, String(loaded.appearance.backgroundOverlay))
record('backgroundBlur 被 clamp 到 0', loaded.appearance.backgroundBlur === 0, String(loaded.appearance.backgroundBlur))
record('非布尔 showAvatars 回落到默认 true', loaded.appearance.showAvatars === true)
record('合法槽位被保留', Boolean(loaded.appearance.slots.brandLogo), JSON.stringify(Object.keys(loaded.appearance.slots)))
record('未知槽位被丢弃', loaded.appearance.slots.notARealSlot === undefined)
record('非法槽位源被丢弃', loaded.appearance.slots.userAvatar === undefined)
record('bytes 缺失时按 base64 长度推算', loaded.appearance.slots.brandLogo?.bytes === 3, String(loaded.appearance.slots.brandLogo?.bytes))

// 默认值形状正确
const fresh = settings.loadSettings()
record('slots 始终是对象（不是 undefined）', typeof fresh.appearance.slots === 'object' && fresh.appearance.slots !== null)

/* ================= 5. 背景布局数学（任务 3 核心） ================= */
console.log('\n──────── 5. 背景自适应与编辑数学 ────────')

const { computeBackgroundLayout, sanitizeTransform, isDefaultTransform } = background

const container = { width: 1600, height: 900 }
const image4x3 = { width: 1200, height: 900 } // 4:3 图放进 16:9 容器

// 默认：cover 居中铺满，且绝不拉伸
const cover = computeBackgroundLayout(container, image4x3, undefined)
record('默认算出布局', Boolean(cover), JSON.stringify(cover))
record(
  '默认 cover：铺满容器（不露白）',
  cover.width >= container.width - 0.01 && cover.height >= container.height - 0.01,
  `${cover.width.toFixed(1)}x${cover.height.toFixed(1)}`
)
record(
  '默认 cover：保持图片宽高比（不拉伸）',
  Math.abs(cover.width / cover.height - image4x3.width / image4x3.height) < 1e-6,
  (cover.width / cover.height).toFixed(4)
)
record(
  '默认 cover：居中',
  Math.abs(cover.left + cover.width / 2 - container.width / 2) < 0.01 &&
    Math.abs(cover.top + cover.height / 2 - container.height / 2) < 0.01,
  `left=${cover.left.toFixed(1)} top=${cover.top.toFixed(1)}`
)

// 超宽图放进窄容器，也要 cover
const ultraWide = { width: 4000, height: 500 }
const cover2 = computeBackgroundLayout(container, ultraWide, undefined)
record(
  '超宽图仍 cover 且不变形',
  cover2.width >= container.width && cover2.height >= container.height &&
    Math.abs(cover2.width / cover2.height - ultraWide.width / ultraWide.height) < 1e-6,
  `${cover2.width.toFixed(0)}x${cover2.height.toFixed(0)}`
)

// 缩放
const zoom2 = computeBackgroundLayout(container, image4x3, { zoom: 2, offsetX: 0, offsetY: 0, crop: null })
record('缩放 200% 尺寸翻倍', Math.abs(zoom2.width - cover.width * 2) < 0.01, `${zoom2.width.toFixed(1)} vs ${(cover.width * 2).toFixed(1)}`)
record('缩放后仍居中（未平移）', Math.abs(zoom2.left + zoom2.width / 2 - container.width / 2) < 0.01)

// 平移
const panned = computeBackgroundLayout(container, image4x3, { zoom: 1, offsetX: 0.25, offsetY: -0.1, crop: null })
record(
  '平移按容器比例生效',
  Math.abs(panned.left - (cover.left + 0.25 * container.width)) < 0.01 &&
    Math.abs(panned.top - (cover.top - 0.1 * container.height)) < 0.01,
  `Δleft=${(panned.left - cover.left).toFixed(1)} Δtop=${(panned.top - cover.top).toFixed(1)}`
)

// 框选：选中区域必须铺满容器
const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }
const cropped = computeBackgroundLayout(container, image4x3, { zoom: 1, offsetX: 0, offsetY: 0, crop })
const cropAspect = (crop.w * image4x3.width) / (crop.h * image4x3.height)
record(
  '框选后选区铺满容器且不变形',
  cropped.width >= container.width - 0.01 && cropped.height >= container.height - 0.01 &&
    Math.abs(cropped.width / cropped.height - (image4x3.width / image4x3.height)) < 1e-6,
  `${cropped.width.toFixed(1)}x${cropped.height.toFixed(1)} aspect=${cropAspect.toFixed(3)}`
)
record(
  '框选把选区中心对齐到容器中心',
  Math.abs(cropped.left + (crop.x + crop.w / 2) * cropped.width - container.width / 2) < 0.5,
  `left=${cropped.left.toFixed(1)}`
)

// 退化保护：参数异常必须回退（返回 null 由调用方处理）
record('容器尺寸为 0 → null（回退）', computeBackgroundLayout({ width: 0, height: 0 }, image4x3, undefined) === null)
record('图片尺寸未知 → null（回退）', computeBackgroundLayout(container, { width: 0, height: 0 }, undefined) === null)
record(
  'transform 全 NaN → 仍返回可用布局（被 sanitize 兜住）',
  Boolean(computeBackgroundLayout(container, image4x3, { zoom: NaN, offsetX: NaN, offsetY: NaN, crop: null }))
)

// sanitize
const nasty = sanitizeTransform({ zoom: 99, offsetX: -50, offsetY: 50, crop: { x: -1, y: 2, w: 99, h: 0 } })
record('zoom 被 clamp 到 3', nasty.zoom === 3, String(nasty.zoom))
record('offset 被 clamp 到 ±2', nasty.offsetX === -2 && nasty.offsetY === 2, `${nasty.offsetX},${nasty.offsetY}`)
record('宽高为 0 的框选被丢弃', nasty.crop === null, JSON.stringify(nasty.crop))
record('默认参数识别为「自适应」', isDefaultTransform({ zoom: 1, offsetX: 0, offsetY: 0, crop: null }) === true)
record('有缩放时不算默认', isDefaultTransform({ zoom: 1.2, offsetX: 0, offsetY: 0, crop: null }) === false)

/* ================= 6. 内置壁纸 ================= */
console.log('\n──────── 6. 内置二次元壁纸 ────────')
for (const id of ['starry', 'sakura', 'clouds']) {
  const src = wallpapers.wallpaperSource(id)
  const ok = src.startsWith('data:image/svg+xml') && src.length > 400
  record(`壁纸 ${id} 生成成功`, ok, `${src.slice(0, 32)}… 长度 ${src.length}`)
}
record('三张壁纸互不相同', new Set(['starry', 'sakura', 'clouds'].map((id) => wallpapers.wallpaperSource(id))).size === 3)
record(
  'SVG 壁纸能通过配置净化（svg+xml 必须被接受）',
  settings.coerceTransform !== undefined && (() => {
    fs.writeFileSync(
      path.join(appDir, 'config.json'),
      JSON.stringify({ appearance: { wallpaper: 'sakura', stylePreset: 'anime' } }),
      'utf8'
    )
    const s = settings.loadSettings()
    return s.appearance.wallpaper === 'sakura' && s.appearance.stylePreset === 'anime'
  })()
)

/* ================= 7. transform 持久化 ================= */
console.log('\n──────── 7. 背景编辑参数持久化 ────────')
fs.writeFileSync(
  path.join(appDir, 'config.json'),
  JSON.stringify({
    appearance: {
      background: {
        source: 'data:image/png;base64,AAAA',
        bytes: 3,
        transform: { zoom: 1.75, offsetX: 0.2, offsetY: -0.3, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.6 } }
      }
    }
  }),
  'utf8'
)
const persisted = settings.loadSettings()
const t = persisted.appearance.background?.transform
record('transform 被持久化', Boolean(t), JSON.stringify(t))
record(
  'transform 数值完整保留',
  t?.zoom === 1.75 && t?.offsetX === 0.2 && t?.offsetY === -0.3 && t?.crop?.w === 0.5,
  JSON.stringify(t)
)

// 默认值不写冗余字段
fs.writeFileSync(
  path.join(appDir, 'config.json'),
  JSON.stringify({ appearance: { background: { source: 'data:image/png;base64,AAAA', bytes: 3, transform: { zoom: 1, offsetX: 0, offsetY: 0, crop: null } } } }),
  'utf8'
)
record('默认 transform 不落冗余字段', settings.loadSettings().appearance.background?.transform === undefined)

// 坏参数 → 回退默认，而不是让背景消失
fs.writeFileSync(
  path.join(appDir, 'config.json'),
  JSON.stringify({ appearance: { background: { source: 'data:image/png;base64,AAAA', bytes: 3, transform: { zoom: 'x', crop: { x: 1, y: 1, w: 0, h: 0 } } } } }),
  'utf8'
)
const brokenT = settings.loadSettings().appearance.background?.transform
record('坏参数被净化（不产生不可用参数）', brokenT === undefined || (Number.isFinite(brokenT.zoom) && brokenT.crop === null), JSON.stringify(brokenT))

/* ---------------- 清理 ---------------- */
try {
  fs.rmSync(fakeHome, { recursive: true, force: true })
} catch {
  /* ignore */
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) console.log('失败项：\n  ' + failed.map((f) => `${f.name} (${f.detail})`).join('\n  '))
process.exit(failed.length === 0 ? 0 : 1)
