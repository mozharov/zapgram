import {describe, expect, test} from 'bun:test'
import {classifyPayoutLookup} from './payout-state.js'

describe('classifyPayoutLookup', () => {
  test('a settled payout is never re-sent', () => {
    expect(classifyPayoutLookup({paid: true})).toBe('paid')
    expect(classifyPayoutLookup({paid: true, status: 'success'})).toBe('paid')
  })

  test('a definitively failed payout may be re-issued', () => {
    expect(classifyPayoutLookup({paid: false, status: 'failed'})).toBe('retryable')
  })

  test('anything still in flight is left alone', () => {
    // The dangerous case: not paid *yet*, but it may still settle. Paying again would double-spend.
    expect(classifyPayoutLookup({paid: false})).toBe('pending')
    expect(classifyPayoutLookup({paid: false, status: 'pending'})).toBe('pending')
  })

  test('an unknown status is treated as in flight, not as retryable', () => {
    expect(classifyPayoutLookup({paid: false, status: 'something_new'})).toBe('pending')
  })
})
