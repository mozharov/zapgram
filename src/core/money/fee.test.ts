import {describe, expect, test} from 'bun:test'
import {computeSubscriptionFee} from './fee.js'

describe('computeSubscriptionFee', () => {
  test('matches Math.ceil(sats * percent)', () => {
    expect(computeSubscriptionFee(1000, 0.05)).toBe(50)
    expect(computeSubscriptionFee(1000, 0)).toBe(0)
    expect(computeSubscriptionFee(1, 0.05)).toBe(1)
    expect(computeSubscriptionFee(19, 0.05)).toBe(1)
  })
})
