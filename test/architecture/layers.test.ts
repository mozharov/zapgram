import {describe, expect, test} from 'bun:test'
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'

const ROOT = join(import.meta.dir, '../../src')

/** Imports that core must never make. */
const CORE_FORBIDDEN = [
  /from\s+['"]@infra\//,
  /from\s+['"]@modules\//,
  /from\s+['"]@telegram\//,
  /from\s+['"]@http\//,
  /from\s+['"]@jobs\//,
  /from\s+['"]@bootstrap\//,
  /from\s+['"]@config/,
  /from\s+['"]\.\.\/.*\/infra\//,
  /from\s+['"]\.\.\/.*\/modules\//,
  /from\s+['"]\.\.\/.*\/telegram\//,
  /from\s+['"]\.\.\/.*\/bot\//,
]

/** Imports that infra must never make. */
const INFRA_FORBIDDEN = [
  /from\s+['"]@modules\//,
  /from\s+['"]@telegram\//,
  /from\s+['"]@http\//,
  /from\s+['"]@jobs\//,
  /from\s+['"]@bootstrap\//,
  /from\s+['"]\.\.\/.*\/modules\//,
  /from\s+['"]\.\.\/.*\/telegram\//,
  /from\s+['"]\.\.\/.*\/bot\//,
  /from\s+['"]\.\.\/.*\/http\//,
  /from\s+['"]\.\.\/.*\/jobs\//,
]

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listTsFiles(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

function findForbidden(file: string, patterns: RegExp[]): string[] {
  const text = readFileSync(file, 'utf8')
  const hits: string[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('from ') && !line.includes('import(')) continue
    // Temporary: pure domain functions still share Drizzle $inferSelect types from infra.
    // Resolved when repositories own the types (step 5+).
    if (/import\s+type\s+/.test(line) && line.includes('@infra/db/types')) continue
    for (const re of patterns) {
      if (re.test(line)) hits.push(line.trim())
    }
  }
  return hits
}

describe('architecture layer boundaries', () => {
  test('core has no forbidden imports', () => {
    const files = listTsFiles(join(ROOT, 'core'))
    const violations: string[] = []
    for (const file of files) {
      for (const hit of findForbidden(file, CORE_FORBIDDEN)) {
        violations.push(`${relative(ROOT, file)}: ${hit}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('infra has no forbidden imports', () => {
    const files = listTsFiles(join(ROOT, 'infra'))
    const violations: string[] = []
    for (const file of files) {
      for (const hit of findForbidden(file, INFRA_FORBIDDEN)) {
        violations.push(`${relative(ROOT, file)}: ${hit}`)
      }
    }
    expect(violations).toEqual([])
  })
})
