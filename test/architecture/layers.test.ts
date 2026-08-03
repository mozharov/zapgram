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

// Modules must not import http/bootstrap.
// Feature UI under modules/.../telegram may use @telegram; jobs may use @jobs.
const MODULES_FORBIDDEN = [/from\s+['"]@http\//, /from\s+['"]@bootstrap\//]

function listTsFiles(dir: string): string[] {
  if (!statSync(dir, {throwIfNoEntry: false})?.isDirectory()) return []
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
    for (const re of patterns) {
      if (re.test(line)) hits.push(line.trim())
    }
  }
  return hits
}

function collectViolations(dir: string, patterns: RegExp[]): string[] {
  const violations: string[] = []
  for (const file of listTsFiles(dir)) {
    for (const hit of findForbidden(file, patterns)) {
      violations.push(`${relative(ROOT, file)}: ${hit}`)
    }
  }
  return violations
}

describe('architecture layer boundaries', () => {
  test('core has no forbidden imports', () => {
    expect(collectViolations(join(ROOT, 'core'), CORE_FORBIDDEN)).toEqual([])
  })

  test('infra has no forbidden imports', () => {
    expect(collectViolations(join(ROOT, 'infra'), INFRA_FORBIDDEN)).toEqual([])
  })

  test('modules has no forbidden imports', () => {
    expect(collectViolations(join(ROOT, 'modules'), MODULES_FORBIDDEN)).toEqual([])
  })
})
