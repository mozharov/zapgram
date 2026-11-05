import {describe, expect, test} from 'bun:test'
import {bolt11MatchingToken, pastedPaymentToken} from './pasted-payment.js'

const USER = 100001
const INVOICE = 'lnbc1pabcdef'
const PASTE = `  Lightning:${INVOICE.toUpperCase()}  `

describe('bolt11MatchingToken', () => {
  test('accepts the same user and the canonical invoice, including lightning: and case', () => {
    const token = pastedPaymentToken(USER, INVOICE)
    expect(bolt11MatchingToken(USER, token, PASTE)).toBe(INVOICE)
    expect(bolt11MatchingToken(USER, token, INVOICE)).toBe(INVOICE)
  })

  test('rejects another user, another invoice, a missing message, and a non-bolt11', () => {
    const token = pastedPaymentToken(USER, INVOICE)
    expect(bolt11MatchingToken(USER + 1, token, INVOICE)).toBeUndefined()
    expect(bolt11MatchingToken(USER, token, 'lnbc1pother')).toBeUndefined()
    expect(bolt11MatchingToken(USER, token, undefined)).toBeUndefined()
    expect(bolt11MatchingToken(undefined, token, INVOICE)).toBeUndefined()
    expect(bolt11MatchingToken(USER, token, 'alice@localhost')).toBeUndefined()
    expect(bolt11MatchingToken(USER, 'not-the-token', INVOICE)).toBeUndefined()
  })
})
