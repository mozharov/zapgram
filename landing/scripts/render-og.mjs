#!/usr/bin/env bun
/**
 * Render OG cards → 1200×630 PNG.
 *
 *   bun landing/scripts/render-og.mjs
 *
 * Sources:
 *   public/assets/og-card.html    → public/assets/og.png
 *   public/assets/og-card-ru.html → public/assets/og-ru.png
 *
 * Requires Playwright Chromium (ms-playwright cache) or CHROME_PATH.
 */
import {existsSync, readdirSync, statSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'public', 'assets')

const jobs = [
  {html: 'og-card.html', out: 'og.png'},
  {html: 'og-card-ru.html', out: 'og-ru.png'},
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

async function renderOne(browser, htmlName, outName) {
  const htmlPath = join(assets, htmlName)
  const pngPath = join(assets, outName)
  const rawPath = join(assets, `og-raw-${outName}`)

  if (!existsSync(htmlPath)) {
    console.error('Missing', htmlPath)
    process.exit(1)
  }

  const page = await browser.newPage({
    viewport: {width: 1200, height: 630},
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
    clip: {x: 0, y: 0, width: 1200, height: 630},
    omitBackground: false,
  })
  await page.close()

  const py = `
from PIL import Image
import os
src = ${JSON.stringify(rawPath)}
png = ${JSON.stringify(pngPath)}
im = Image.open(src).convert('RGB')
if im.size == (2400, 1260):
    im = im.resize((1200, 630), Image.Resampling.LANCZOS)
elif im.size != (1200, 630):
    canvas = Image.new('RGB', (1200, 630), (10, 10, 10))
    piece = im.crop((0, 0, min(im.width, 2400), min(im.height, 1260)))
    if piece.size == (2400, 1260):
        piece = piece.resize((1200, 630), Image.Resampling.LANCZOS)
    else:
        piece = piece.resize(
            (min(1200, piece.width), min(630, piece.height)),
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
    await renderOne(browser, job.html, job.out)
  }
} finally {
  await browser.close()
}
