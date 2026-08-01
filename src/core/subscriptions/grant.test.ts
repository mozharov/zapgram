import {beforeEach, describe, expect, test} from 'bun:test'
import {
  type GrantPayment,
  type GrantSubscription,
  type GrantSubscriptionAccessDeps,
  grantSubscriptionAccessIfNeeded,
} from './grant.js'
import {ONE_MONTH_IN_MS} from './policy.js'

const now = new Date('2026-03-01T12:00:00.000Z')
const existingEndsAt = new Date('2026-04-01T12:00:00.000Z')

function basePayment(overrides: Partial<GrantPayment> = {}): GrantPayment {
  return {
    id: 'pay-1',
    userId: 10,
    chatId: -100,
    price: 1000,
    paymentHash: 'hash1',
    subscriptionType: 'monthly',
    settledAt: null,
    ...overrides,
  }
}

function existingSubscription(): GrantSubscription {
  return {
    id: 'sub-1',
    userId: 10,
    chatId: -100,
    price: 1000,
    endsAt: existingEndsAt,
    notificationSent: false,
  }
}

describe('grantSubscriptionAccessIfNeeded', () => {
  let deps: GrantSubscriptionAccessDeps
  let subscription: GrantSubscription | null
  let settledAt: Date | null
  let createCalls: unknown[]
  let updateCalls: unknown[]

  beforeEach(() => {
    subscription = existingSubscription()
    settledAt = null
    createCalls = []
    updateCalls = []
    deps = {
      getSubscriptionByUserAndChat: () => subscription,
      createSubscription: data => {
        createCalls.push(data)
        subscription = {
          id: 'sub-new',
          userId: data.userId,
          chatId: data.chatId,
          price: data.price,
          endsAt: data.endsAt,
          notificationSent: false,
        }
      },
      updateSubscription: (id, data) => {
        updateCalls.push({id, data})
        if (subscription) subscription = {...subscription, ...data}
      },
      markPaymentSettled: (_id, at) => {
        settledAt = at
      },
      log: {info: () => {}},
    }
  })

  test('first call grants and extends endsAt once', () => {
    expect(grantSubscriptionAccessIfNeeded(basePayment(), deps, now)).toBe('granted')
    expect(updateCalls).toHaveLength(1)
    expect(subscription?.endsAt?.getTime()).toBe(existingEndsAt.getTime() + ONE_MONTH_IN_MS)
    expect(settledAt).toEqual(now)
  })

  test('second call with settledAt does not extend again', () => {
    grantSubscriptionAccessIfNeeded(basePayment(), deps, now)
    const ends = subscription?.endsAt?.getTime()
    expect(grantSubscriptionAccessIfNeeded(basePayment({settledAt: now}), deps, now)).toBe(
      'already_settled',
    )
    expect(subscription?.endsAt?.getTime()).toBe(ends)
  })

  test('creates subscription when none exists', () => {
    subscription = null
    expect(grantSubscriptionAccessIfNeeded(basePayment(), deps, now)).toBe('granted')
    expect(createCalls).toHaveLength(1)
    const created = createCalls[0] as {
      userId: number
      chatId: number
      price: number
      endsAt: Date | null
    }
    expect(created.endsAt?.getTime()).toBe(now.getTime() + ONE_MONTH_IN_MS)
  })

  test('one_time payment grants permanent access', () => {
    subscription = null
    grantSubscriptionAccessIfNeeded(basePayment({subscriptionType: 'one_time'}), deps, now)
    const created = createCalls[0] as {endsAt: Date | null}
    expect(created.endsAt).toBeNull()
  })

  test('settles the payment only after the subscription write', () => {
    const order: string[] = []
    deps.updateSubscription = (_id, data) => {
      order.push('update')
      if (subscription) subscription = {...subscription, ...data}
    }
    deps.markPaymentSettled = () => {
      order.push('settle')
      settledAt = now
    }
    grantSubscriptionAccessIfNeeded(basePayment(), deps, now)
    expect(order).toEqual(['update', 'settle'])
  })
})
