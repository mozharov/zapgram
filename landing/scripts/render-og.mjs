#!/usr/bin/env bun
/**
 * Render HTML cards → PNG (Open Graph + bot empty-chat description).
 *
 *   bun landing/scripts/render-og.mjs
 *
 * Sources:
 *   public/assets/og-card.html                 → public/assets/og.png            (1200×630)
 *   public/assets/og-card-ru.html              → public/assets/og-ru.png         (1200×630)
 *   public/assets/bot-description-card.html    → public/assets/bot-description-en.png (640×360)
 *   public/assets/bot-description-card-ru.html → public/assets/bot-description-ru.png (640×360)
 *
 * Bot description PNGs are also copied to repo `assets/bot-description/` for
 * BotFather upload (Bot API cannot set description media — only text via
 * setMyDescription / configureBot). BotFather requires photo **640×360**.
 *
 * Requires Playwright Chromium (ms-playwright cache) or CHROME_PATH.
 */
import {spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, readdirSync, statSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..')
const assets = join(root, 'public', 'assets')
const botDescriptionDir = join(repoRoot, 'assets', 'bot-description')

const jobs = [
  {html: 'og-card.html', out: 'og.png', width: 1200, height: 630},
  {html: 'og-card-ru.html', out: 'og-ru.png', width: 1200, height: 630},
  {
    html: 'bot-description-card.html',
    out: 'bot-description-en.png',
    width: 640,
    height: 360,
    botCopy: true,
  },
  {
    html: 'bot-description-card-ru.html',
    out: 'bot-description-ru.png',
    width: 640,
    height: 360,
    botCopy: true,
  },
]

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

async function renderOne(browser, job) {
  const {html: htmlName, out: outName, width, height, botCopy = false} = job
  const htmlPath = join(assets, htmlName)
  const pngPath = join(assets, outName)
  const rawPath = join(assets, `og-raw-${outName}`)

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
    console.error(pyResult.stderr || pyResult.stdout)
    process.exit(pyResult.status ?? 1)
  }
  console.log(pyResult.stdout.trim())

  if (botCopy) {
    mkdirSync(botDescriptionDir, {recursive: true})
    const dest = join(botDescriptionDir, outName)
    copyFileSync(pngPath, dest)
    console.log(`copied → assets/bot-description/${outName}`)
  }
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
    await renderOne(browser, job)
  }
} finally {
  await browser.close()
}
