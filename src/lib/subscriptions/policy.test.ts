import {describe, expect, test} from 'bun:test'
import {computeSubscriptionEndsAt, ONE_MONTH_IN_MS} from './policy.js'

describe('computeSubscriptionEndsAt', () => {
  const now = new Date('2026-01-15T12:00:00.000Z')

  test('one_time is permanent (null)', () => {
    expect(
      computeSubscriptionEndsAt({
        subscriptionType: 'one_time',
        existingEndsAt: new Date('2026-02-01T00:00:00.000Z'),
        now,
      }),
    ).toBeNull()
  })

  test('monthly without existing starts at now + 1 month', () => {
    const endsAt = computeSubscriptionEndsAt({
      subscriptionType: 'monthly',
      existingEndsAt: null,
      now,
    })
    expect(endsAt?.getTime()).toBe(now.getTime() + ONE_MONTH_IN_MS)
  })

  test('monthly extends active subscription from existing endsAt', () => {
    const existing = new Date('2026-02-01T12:00:00.000Z')
    const endsAt = computeSubscriptionEndsAt({
      subscriptionType: 'monthly',
      existingEndsAt: existing,
      now,
    })
    expect(endsAt?.getTime()).toBe(existing.getTime() + ONE_MONTH_IN_MS)
  })

  test('monthly expired subscription restarts from now', () => {
    const existing = new Date('2026-01-01T12:00:00.000Z')
    const endsAt = computeSubscriptionEndsAt({
      subscriptionType: 'monthly',
      existingEndsAt: existing,
      now,
    })
    expect(endsAt?.getTime()).toBe(now.getTime() + ONE_MONTH_IN_MS)
  })
})
