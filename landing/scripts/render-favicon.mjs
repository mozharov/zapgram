#!/usr/bin/env bun
/**
 * Rasterize logo.svg → favicon PNGs + multi-size ICO.
 *
 *   bun landing/scripts/render-favicon.mjs
 *
 * Outputs (under public/assets/):
 *   favicon-16.png
 *   favicon-32.png
 *   apple-touch-icon.png   (180×180)
 *   favicon.ico            (16 + 32)
 *
 * Requires Playwright Chromium (ms-playwright cache) or CHROME_PATH, and PIL.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')
const assets = join(publicDir, 'assets')
const logoPath = join(assets, 'logo.svg')
const faviconSvgPath = join(assets, 'favicon.svg')

const sizes = [
  {name: 'favicon-16.png', size: 16},
  {name: 'favicon-32.png', size: 32},
  {name: 'apple-touch-icon.png', size: 180},
]

function writeFaviconSvg() {
  const src = readFileSync(logoPath, 'utf8')
  const out = src.replace('width="100%" height="auto"', 'width="32" height="32"')
  writeFileSync(faviconSvgPath, out)
  console.log('wrote favicon.svg')
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }
  const base = join(homedir(), 'Library/Caches/ms-playwright')
  if (!existsSync(base)) return null
  const candidates = []
  for (const name of readdirSync(base)) {
    if (!name.startsWith('chromium')) continue
    walk(join(base, name), candidates, 6)
  }
  return (
    candidates.find((p) => p.includes('Google Chrome for Testing')) ??
    candidates[0] ??
    null
  )
}

function walk(dir, out, depth) {
  if (depth < 0 || !existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === 'Helpers' || name === 'resources') continue
      walk(p, out, depth - 1)
    } else if (
      name === 'Google Chrome for Testing' ||
      name === 'chrome-headless-shell' ||
      name === 'Chromium'
    ) {
      out.push(p)
    }
  }
}

async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch {
    try {
      return await import('/tmp/node_modules/playwright-core/index.mjs')
    } catch {
      return null
    }
  }
}

function buildHtml(logoUrl) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        background: #0a0a0a;
        overflow: hidden;
      }
      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    </style>
  </head>
  <body>
    <img src="${logoUrl}" alt="" width="640" height="640" />
  </body>
</html>`
}

async function renderSize(browser, size, outPath) {
  const page = await browser.newPage({
    viewport: {width: size, height: size},
    deviceScaleFactor: 1,
  })
  const htmlPath = join(assets, `.favicon-render-${size}.html`)
  const logoUrl = pathToFileURL(logoPath).href
  writeFileSync(htmlPath, buildHtml(logoUrl))
  try {
    await page.goto(pathToFileURL(htmlPath).href, {waitUntil: 'networkidle'})
    await page.waitForTimeout(100)
    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: {x: 0, y: 0, width: size, height: size},
      omitBackground: false,
    })
  } finally {
    await page.close()
    try {
      unlinkSync(htmlPath)
    } catch {
      /* ignore */
    }
  }
}

function writeIco() {
  const py = `
from PIL import Image
from pathlib import Path
assets = Path(${JSON.stringify(assets)})
imgs = []
for name in ('favicon-16.png', 'favicon-32.png'):
    p = assets / name
    im = Image.open(p).convert('RGBA')
    assert im.size[0] == im.size[1], (name, im.size)
    imgs.append(im)
out = assets / 'favicon.ico'
# Pillow writes multi-size ICO from the largest as base + sizes=
imgs[-1].save(
    out,
    format='ICO',
    sizes=[(im.width, im.height) for im in imgs],
    append_images=imgs[:-1],
)
print(f'favicon.ico bytes={out.stat().st_size} sizes={[im.size for im in imgs]}')
for name in ('favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'):
    p = assets / name
    im = Image.open(p)
    print(f'{name} size={im.size} bytes={p.stat().st_size}')
`
  const pyResult = spawnSync('python3', ['-c', py], {encoding: 'utf8'})
  if (pyResult.status !== 0) {
    console.error(pyResult.stderr || pyResult.stdout)
    process.exit(pyResult.status ?? 1)
  }
  console.log(pyResult.stdout.trim())
}

if (!existsSync(logoPath)) {
  console.error('Missing', logoPath)
  process.exit(1)
}

writeFaviconSvg()

const chrome = findChrome()
if (!chrome) {
  console.error('No Chromium found. Set CHROME_PATH or install Playwright browsers.')
  process.exit(1)
}

console.log('Chrome:', chrome)

const pw = await loadPlaywright()
if (!pw) {
  console.error('playwright-core not found. Install: bun add -d playwright-core')
  process.exit(1)
}

const browser = await pw.chromium.launch({
  executablePath: chrome,
  headless: true,
})
try {
  for (const {name, size} of sizes) {
    const outPath = join(assets, name)
    await renderSize(browser, size, outPath)
    console.log(`wrote ${name} (${size}×${size})`)
  }
} finally {
  await browser.close()
}

writeIco()
copyFileSync(join(assets, 'favicon.ico'), join(publicDir, 'favicon.ico'))
console.log('copied public/favicon.ico')
console.log('done')
