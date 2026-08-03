import {describe, expect, test} from 'bun:test'
import {
  chatChangePriceRoute,
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatRemoveCustomMessageRoute,
  chatRoute,
  chatsPageRoute,
  parameterizedRoutes,
  paySubscriptionRoute,
  subscriptionRenewRoute,
  subscriptionRoute,
  subscriptionsPageRoute,
} from './callback-data.js'

describe('callback-data routes', () => {
  test('round-trip build → pattern → parse for every parameterized route', () => {
    const samples = [
      {route: chatsPageRoute, params: {page: 3}},
      {route: chatRoute, params: {chatId: -100123}},
      {route: chatPaidAccessRoute, params: {chatId: -100, status: 'active' as const}},
      {route: chatPaidAccessRoute, params: {chatId: 42, status: 'inactive' as const}},
      {route: chatPaymentTypeRoute, params: {chatId: -1, paymentType: 'monthly' as const}},
      {route: chatPaymentTypeRoute, params: {chatId: 1, paymentType: 'one_time' as const}},
      {route: chatChangePriceRoute, params: {chatId: -100}},
      {route: chatCustomMessageRoute, params: {chatId: 5}},
      {route: chatEditCustomMessageRoute, params: {chatId: 5}},
      {route: chatRemoveCustomMessageRoute, params: {chatId: 5}},
      {route: subscriptionsPageRoute, params: {page: 2}},
      {
        route: subscriptionRoute,
        params: {subscriptionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'},
      },
      {
        route: subscriptionRenewRoute,
        params: {subscriptionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'},
      },
      {
        route: paySubscriptionRoute,
        params: {
          paymentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          from: 'wallet' as const,
        },
      },
      {
        route: paySubscriptionRoute,
        params: {
          paymentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          from: 'nwc' as const,
        },
      },
    ] as const

    for (const {route, params} of samples) {
      const built = route.build(params as never)
      expect(route.pattern.test(built)).toBe(true)
      const match = route.pattern.exec(built)
      expect(match).not.toBeNull()
      if (!match) throw new Error('expected match')
      expect(route.parse(match)).toEqual(params)
      expect(route.parse(built)).toEqual(params)
    }
  })

  test('every parameterized route is listed in parameterizedRoutes', () => {
    expect(parameterizedRoutes).toHaveLength(12)
  })
})
