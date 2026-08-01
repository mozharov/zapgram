import {beforeEach, describe, expect, test} from 'bun:test'
import type {Subscription, SubscriptionPayment} from '../../lib/database/types.js'
import {type GrantSubscriptionAccessDeps, grantSubscriptionAccessIfNeeded} from './grant.js'
import {ONE_MONTH_IN_MS} from './policy.js'

const now = new Date('2026-03-01T12:00:00.000Z')
const existingEndsAt = new Date('2026-04-01T12:00:00.000Z')

function basePayment(overrides: Partial<SubscriptionPayment> = {}): SubscriptionPayment {
  return {
    id: 'pay-1',
    userId: 10,
    chatId: -100,
    paymentRequest: 'lnbc1',
    paymentHash: 'hash1',
    price: 1000,
    subscriptionType: 'monthly',
    kind: 'join',
    settledAt: null,
    settleAttempts: 0,
    payoutHash: null,
    feePayoutHash: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  }
}

function existingSubscription(): Subscription {
  return {
    id: 'sub-1',
    userId: 10,
    chatId: -100,
    price: 1000,
    endsAt: existingEndsAt,
    autoRenew: true,
    notificationSent: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
}

describe('grantSubscriptionAccessIfNeeded', () => {
  let updateSubscriptionCalls = 0
  let createSubscriptionCalls = 0
  let lastUpdateEndsAt: Date | null | undefined
  let lastCreateEndsAt: Date | null | undefined
  let markedSettledAt: Date | null = null
  let callOrder: string[] = []

  beforeEach(() => {
    updateSubscriptionCalls = 0
    createSubscriptionCalls = 0
    lastUpdateEndsAt = null
    lastCreateEndsAt = null
    markedSettledAt = null
    callOrder = []
  })

  function createDeps(
    subscription: Subscription | null = existingSubscription(),
  ): GrantSubscriptionAccessDeps {
    return {
      getSubscriptionByUserAndChat: () => subscription,
      updateSubscription: (_id, data) => {
        updateSubscriptionCalls++
        lastUpdateEndsAt = data.endsAt
        callOrder.push('update')
      },
      createSubscription: data => {
        createSubscriptionCalls++
        lastCreateEndsAt = data.endsAt
        callOrder.push('create')
      },
      markPaymentSettled: (_id, settledAt) => {
        markedSettledAt = settledAt
        callOrder.push('settle')
      },
      log: {info: () => {}},
    }
  }

  test('first call grants and extends endsAt once', () => {
    const result = grantSubscriptionAccessIfNeeded(basePayment(), createDeps(), now)
    expect(result).toBe('granted')
    expect(updateSubscriptionCalls).toBe(1)
    expect(createSubscriptionCalls).toBe(0)
    expect(lastUpdateEndsAt?.getTime()).toBe(existingEndsAt.getTime() + ONE_MONTH_IN_MS)
    expect(markedSettledAt?.getTime()).toBe(now.getTime())
  })

  test('second call with settledAt does not extend again', () => {
    const result = grantSubscriptionAccessIfNeeded(basePayment({settledAt: now}), createDeps(), now)
    expect(result).toBe('already_settled')
    expect(updateSubscriptionCalls).toBe(0)
    expect(createSubscriptionCalls).toBe(0)
    expect(markedSettledAt).toBeNull()
  })

  test('creates subscription when none exists', () => {
    const result = grantSubscriptionAccessIfNeeded(basePayment(), createDeps(null), now)
    expect(result).toBe('granted')
    expect(createSubscriptionCalls).toBe(1)
    expect(updateSubscriptionCalls).toBe(0)
    expect(lastCreateEndsAt?.getTime()).toBe(now.getTime() + ONE_MONTH_IN_MS)
    expect(markedSettledAt?.getTime()).toBe(now.getTime())
  })

  test('one_time payment grants permanent access', () => {
    const result = grantSubscriptionAccessIfNeeded(
      basePayment({subscriptionType: 'one_time'}),
      createDeps(null),
      now,
    )
    expect(result).toBe('granted')
    expect(lastCreateEndsAt).toBeNull()
  })

  test('settles the payment only after the subscription write', () => {
    grantSubscriptionAccessIfNeeded(basePayment(), createDeps(), now)
    expect(callOrder).toEqual(['update', 'settle'])
  })
})
