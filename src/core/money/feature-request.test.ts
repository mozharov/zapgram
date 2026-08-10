import {describe, expect, test} from 'bun:test'
import {isValidFeatureRequestText, normalizeFeatureRequestText} from './feature-request.js'

describe('feature request text', () => {
  test('rejects empty / whitespace-only', () => {
    expect(isValidFeatureRequestText('')).toBe(false)
    expect(isValidFeatureRequestText('   \n  ')).toBe(false)
    expect(isValidFeatureRequestText('a')).toBe(true)
  })

  test('allows long single-message bodies', () => {
    expect(isValidFeatureRequestText('x'.repeat(4000))).toBe(true)
  })

  test('trims ends but keeps internal newlines', () => {
    expect(normalizeFeatureRequestText('  hello\n\n  world  ')).toBe('hello\n\n  world')
  })
})
