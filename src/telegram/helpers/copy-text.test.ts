import {describe, expect, test} from 'bun:test'
import {COPY_TEXT_MAX_LENGTH, copyableText} from './copy-text.js'

describe('copyableText', () => {
  test('accepts text that fits on a copy_text button', () => {
    expect(copyableText('lnbc1short')).toBe('lnbc1short')
    expect(copyableText('x'.repeat(COPY_TEXT_MAX_LENGTH))).toHaveLength(COPY_TEXT_MAX_LENGTH)
  })

  test('rejects empty text and anything over the Bot API limit', () => {
    expect(copyableText('')).toBeUndefined()
    expect(copyableText('x'.repeat(COPY_TEXT_MAX_LENGTH + 1))).toBeUndefined()
  })
})
