import {describe, expect, test} from 'bun:test'
import {sanitizeMemo} from './memo.js'

const footer = 'Powered by t.me/zap_gram_bot'

describe('sanitizeMemo', () => {
  test('hides a description that is only the embedded footer', () => {
    expect(sanitizeMemo(footer, footer)).toBe('')
    expect(sanitizeMemo(`  ${footer}  `, footer)).toBe('')
  })

  test('keeps a real memo and strips the trailing footer', () => {
    expect(sanitizeMemo(`coffee\n\n${footer}`, footer)).toBe('coffee')
  })
})
