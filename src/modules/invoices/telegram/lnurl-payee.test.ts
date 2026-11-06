import {describe, expect, test} from 'bun:test'
import {lnurlPayeeHtml} from './lnurl-payee.js'

describe('lnurlPayeeHtml', () => {
  test('shows the plain description and the identifier', () => {
    expect(lnurlPayeeHtml('Pay Alice', 'alice@example.com')).toBe(
      '<b>Pay Alice</b> <code>alice@example.com</code>',
    )
  })

  test('escapes markup from the recipient', () => {
    expect(lnurlPayeeHtml('A & B <b>no</b>', '')).toBe('<b>A &amp; B &lt;b&gt;no&lt;/b&gt;</b>')
  })

  test('is empty when the recipient published neither', () => {
    expect(lnurlPayeeHtml('  ', '  ')).toBeUndefined()
  })
})
