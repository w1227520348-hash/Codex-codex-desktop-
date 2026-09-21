/**
 * 内置二次元壁纸：星空 / 樱花 / 云海。
 *
 * 用内联 SVG data URL 而不是位图：矢量在任何分辨率下都清晰、体积极小、
 * 不需要往仓库里塞二进制资源。注意 `<img src="data:image/svg+xml,...">`
 * 是「被动」文档，脚本与外部引用都不会执行，因此是安全的。
 */

import type { BuiltinWallpaperId } from '@shared/types'

const W = 1600
const H = 900

/** 固定种子的伪随机，保证每次生成的图案一致（可测试、不会闪烁） */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

function stars(): string {
  const rand = seeded(20240601)
  const parts: string[] = []
  for (let i = 0; i < 130; i++) {
    const x = (rand() * W).toFixed(1)
    const y = (rand() * (H * 0.85)).toFixed(1)
    const r = (0.6 + rand() * 1.9).toFixed(2)
    const o = (0.35 + rand() * 0.6).toFixed(2)
    parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${o}"/>`)
  }
  // 几颗带光晕的大星
  for (let i = 0; i < 6; i++) {
    const x = (rand() * W).toFixed(1)
    const y = (rand() * H * 0.6).toFixed(1)
    parts.push(
      `<circle cx="${x}" cy="${y}" r="7" fill="#fff6c9" opacity="0.28"/>`,
      `<circle cx="${x}" cy="${y}" r="2.6" fill="#ffffff" opacity="0.95"/>`
    )
  }
  return parts.join('')
}

function petals(): string {
  const rand = seeded(778899)
  const parts: string[] = []
  for (let i = 0; i < 46; i++) {
    const x = (rand() * W).toFixed(1)
    const y = (rand() * H).toFixed(1)
    const s = (0.6 + rand() * 1.1).toFixed(2)
    const rot = (rand() * 360).toFixed(0)
    const o = (0.35 + rand() * 0.5).toFixed(2)
    parts.push(
      `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" opacity="${o}">` +
        `<path d="M0 0 C 9 -7, 20 -3, 20 6 C 20 15, 9 19, 0 12 C -9 19, -20 15, -20 6 C -20 -3, -9 -7, 0 0 Z" fill="#ffd0e2"/>` +
        `<circle cx="0" cy="6" r="2.4" fill="#ff9dc4"/>` +
        `</g>`
    )
  }
  return parts.join('')
}

function clouds(): string {
  const rand = seeded(31415926)
  const parts: string[] = []
  for (let i = 0; i < 26; i++) {
    const cx = (rand() * W).toFixed(0)
    const cy = (H * 0.42 + rand() * H * 0.5).toFixed(0)
    const rx = (90 + rand() * 190).toFixed(0)
    const ry = (26 + rand() * 42).toFixed(0)
    const o = (0.25 + rand() * 0.45).toFixed(2)
    parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#ffffff" opacity="${o}"/>`)
  }
  return parts.join('')
}

function svg(body: string, defs: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">` +
    `<defs>${defs}</defs>${body}</svg>`
  )
}

const WALLPAPER_SVG: Record<BuiltinWallpaperId, string> = {
  starry: svg(
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>` +
      `<circle cx="1280" cy="180" r="76" fill="#fff4d6" opacity="0.95"/>` +
      `<circle cx="1252" cy="158" r="70" fill="url(#sky)" opacity="0.9"/>` +
      stars() +
      // 流星
      `<path d="M300 120 L520 320" stroke="url(#shoot)" stroke-width="3" stroke-linecap="round" fill="none"/>` +
      `<path d="M980 90 L1150 240" stroke="url(#shoot)" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.7"/>`,
    `<linearGradient id="sky" x1="0" y1="0" x2="0.3" y2="1">` +
      `<stop offset="0%" stop-color="#1b2350"/><stop offset="45%" stop-color="#2b2a63"/>` +
      `<stop offset="100%" stop-color="#5b3f7a"/></linearGradient>` +
      `<linearGradient id="shoot" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0%" stop-color="#ffffff" stop-opacity="0"/><stop offset="100%" stop-color="#ffe9a8" stop-opacity="0.9"/>` +
      `</linearGradient>`
  ),

  sakura: svg(
    `<rect width="${W}" height="${H}" fill="url(#sakura)"/>` +
      `<circle cx="1320" cy="200" r="120" fill="#fff0f6" opacity="0.55"/>` +
      `<path d="M0 760 C 260 700, 420 820, 700 780 C 980 740, 1240 830, ${W} 770 L ${W} ${H} L 0 ${H} Z" fill="#ffd7e8" opacity="0.55"/>` +
      `<path d="M0 840 C 300 790, 520 880, 820 840 C 1120 800, 1360 880, ${W} 845 L ${W} ${H} L 0 ${H} Z" fill="#ffc2dc" opacity="0.6"/>` +
      petals(),
    `<linearGradient id="sakura" x1="0" y1="0" x2="0.4" y2="1">` +
      `<stop offset="0%" stop-color="#ffeaf3"/><stop offset="40%" stop-color="#ffd6e8"/>` +
      `<stop offset="100%" stop-color="#ffe9c9"/></linearGradient>`
  ),

  clouds: svg(
    `<rect width="${W}" height="${H}" fill="url(#dawn)"/>` +
      `<circle cx="1180" cy="300" r="96" fill="#fff7d1" opacity="0.9"/>` +
      `<circle cx="1180" cy="300" r="150" fill="#fff2b8" opacity="0.28"/>` +
      clouds() +
      `<path d="M0 700 C 300 640, 560 740, 860 690 C 1160 640, 1380 730, ${W} 690 L ${W} ${H} L 0 ${H} Z" fill="#ffffff" opacity="0.5"/>`,
    `<linearGradient id="dawn" x1="0" y1="0" x2="0.5" y2="1">` +
      `<stop offset="0%" stop-color="#8fd3ff"/><stop offset="45%" stop-color="#c9b6ff"/>` +
      `<stop offset="100%" stop-color="#ffd9e8"/></linearGradient>`
  )
}

export function wallpaperSource(id: BuiltinWallpaperId): string {
  // charset=utf-8 + encodeURIComponent：比 base64 更短，也便于排查
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(WALLPAPER_SVG[id])}`
}

/** 给设置页画缩略图用（体积很小的同一份 SVG） */
export function wallpaperThumb(id: BuiltinWallpaperId): string {
  return wallpaperSource(id)
}
