#!/usr/bin/env bun
/**
 * Render HTML cards → PNG/GIF.
 *
 *   bun landing/scripts/render-og.mjs
 *
 * Open Graph (1200×630 PNG):
 *   public/assets/og-card.html    → public/assets/og.png
 *   public/assets/og-card-ru.html → public/assets/og-ru.png
 *
 * Bot empty-chat description (BotFather):
 *   public/assets/bot-description-card.html
 *     → bot-description-en.png  (640×360 photo)
 *     → bot-description-en.gif  (960×540 GIF)
 *   public/assets/bot-description-card-ru.html
 *     → bot-description-ru.png / .gif
 *
 * Requires Playwright Chromium (ms-playwright cache) or CHROME_PATH + Pillow.
 */
import {spawnSync} from 'node:child_process'
import {existsSync, readdirSync, statSync, unlinkSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'public', 'assets')

/** @typedef {{html: string, kind: 'og', out: string, width: number, height: number}} OgJob */
/** @typedef {{html: string, kind: 'bot-description', base: string}} BotJob */
/** @typedef {OgJob | BotJob} Job */

/** @type {Job[]} */
const jobs = [
  {html: 'og-card.html', kind: 'og', out: 'og.png', width: 1200, height: 630},
  {html: 'og-card-ru.html', kind: 'og', out: 'og-ru.png', width: 1200, height: 630},
  {html: 'bot-description-card.html', kind: 'bot-description', base: 'bot-description-en'},
  {html: 'bot-description-card-ru.html', kind: 'bot-description', base: 'bot-description-ru'},
]

const BOT_DESIGN_W = 960
const BOT_DESIGN_H = 540
const BOT_PHOTO_W = 640
const BOT_PHOTO_H = 360

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

/**
 * @param {import('playwright-core').Browser} browser
 * @param {number} width
 * @param {number} height
 * @param {string} htmlName
 * @param {string} rawPath
 */
async function screenshotHtml(browser, width, height, htmlName, rawPath) {
  const htmlPath = join(assets, htmlName)
  if (!existsSync(htmlPath)) {
    console.error('Missing', htmlPath)
    process.exit(1)
  }

  const page = await browser.newPage({
    viewport: {width, height},
    deviceScaleFactor: 2,
  })
  await page.goto(pathToFileURL(htmlPath).href, {waitUntil: 'networkidle'})
  await page.evaluate(async () => {
    // @ts-expect-error document.fonts in browser
    if (document.fonts?.ready) await document.fonts.ready
  })
  await page.waitForTimeout(200)
  await page.screenshot({
    path: rawPath,
    type: 'png',
    clip: {x: 0, y: 0, width, height},
    omitBackground: false,
  })
  await page.close()
}

/**
 * @param {import('playwright-core').Browser} browser
 * @param {OgJob} job
 */
async function renderOg(browser, job) {
  const {html: htmlName, out: outName, width, height} = job
  const pngPath = join(assets, outName)
  const rawPath = join(assets, `og-raw-${outName}`)

  await screenshotHtml(browser, width, height, htmlName, rawPath)

  const py = `
from PIL import Image
import os
src = ${JSON.stringify(rawPath)}
png = ${JSON.stringify(pngPath)}
w, h = ${width}, ${height}
im = Image.open(src).convert('RGB')
if im.size == (w * 2, h * 2):
    im = im.resize((w, h), Image.Resampling.LANCZOS)
elif im.size != (w, h):
    canvas = Image.new('RGB', (w, h), (10, 10, 10))
    piece = im.crop((0, 0, min(im.width, w * 2), min(im.height, h * 2)))
    if piece.size == (w * 2, h * 2):
        piece = piece.resize((w, h), Image.Resampling.LANCZOS)
    else:
        piece = piece.resize(
            (min(w, piece.width), min(h, piece.height)),
            Image.Resampling.LANCZOS,
        )
    canvas.paste(piece, (0, 0))
    im = canvas
im.save(png, 'PNG', optimize=True)
os.remove(src)
print(f'{os.path.basename(png)} size={im.size} bytes={os.path.getsize(png)}')
`
  const pyResult = spawnSync('python3', ['-c', py], {encoding: 'utf8'})
  if (pyResult.status !== 0) {
    try {
      unlinkSync(rawPath)
    } catch {
      /* ignore */
    }
    console.error(pyResult.stderr || pyResult.stdout)
    process.exit(pyResult.status ?? 1)
  }
  console.log(pyResult.stdout.trim())
}

/**
 * Design at 960×540 → GIF full size + PNG photo 640×360.
 * @param {import('playwright-core').Browser} browser
 * @param {BotJob} job
 */
async function renderBotDescription(browser, job) {
  const rawPath = join(assets, `og-raw-${job.base}.png`)
  const pngPath = join(assets, `${job.base}.png`)
  const gifPath = join(assets, `${job.base}.gif`)

  await screenshotHtml(browser, BOT_DESIGN_W, BOT_DESIGN_H, job.html, rawPath)

  const py = `
from PIL import Image
import os

raw = ${JSON.stringify(rawPath)}
png = ${JSON.stringify(pngPath)}
gif = ${JSON.stringify(gifPath)}
design = (${BOT_DESIGN_W}, ${BOT_DESIGN_H})
photo = (${BOT_PHOTO_W}, ${BOT_PHOTO_H})

im = Image.open(raw).convert('RGB')
if im.size == (design[0] * 2, design[1] * 2):
    full = im.resize(design, Image.Resampling.LANCZOS)
else:
    full = im.resize(design, Image.Resampling.LANCZOS)

gif_im = full.convert('P', palette=Image.Palette.ADAPTIVE, colors=64)
gif_im.save(gif, 'GIF', optimize=True)
print(f'{os.path.basename(gif)} size={full.size} bytes={os.path.getsize(gif)}')

photo_im = full.resize(photo, Image.Resampling.LANCZOS)
photo_im.save(png, 'PNG', optimize=True)
print(f'{os.path.basename(png)} size={photo_im.size} bytes={os.path.getsize(png)}')

os.remove(raw)
`
  const pyResult = spawnSync('python3', ['-c', py], {encoding: 'utf8'})
  if (pyResult.status !== 0) {
    try {
      unlinkSync(rawPath)
    } catch {
      /* ignore */
    }
    console.error(pyResult.stderr || pyResult.stdout)
    process.exit(pyResult.status ?? 1)
  }
  console.log(pyResult.stdout.trim())
}

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
  for (const job of jobs) {
    if (job.kind === 'og') {
      await renderOg(browser, job)
    } else {
      await renderBotDescription(browser, job)
    }
  }
} finally {
  await browser.close()
}
