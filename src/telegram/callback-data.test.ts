import {describe, expect, test} from 'bun:test'
import {
  broadcastConfirmRoute,
  broadcastLocaleRoute,
  chatChangePriceRoute,
  chatCustomMessageEditRoute,
  chatCustomMessagePreviewRoute,
  chatCustomMessageResetRoute,
  chatCustomMessageRoute,
  chatEditCustomMessageRoute,
  chatOnchainDisableRoute,
  chatOnchainEnableRoute,
  chatPaidAccessRoute,
  chatPaymentTypeRoute,
  chatRemoveCustomMessageRoute,
  chatRoute,
  chatsPageRoute,
  donateAmountRoute,
  donateMonthlyAmountRoute,
  donationPercentRoute,
  donationScopeRoute,
  featureFundAmountRoute,
  parameterizedRoutes,
  payJoinBalanceRoute,
  payLightningRoute,
  payOnchainRoute,
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
      {route: chatCustomMessageEditRoute, params: {chatId: -5, locale: 'ru' as const}},
      {route: chatCustomMessagePreviewRoute, params: {chatId: -5, locale: 'en' as const}},
      {route: chatCustomMessageResetRoute, params: {chatId: 5, locale: 'ru' as const}},
      {route: chatOnchainEnableRoute, params: {chatId: -100}},
      {route: chatOnchainDisableRoute, params: {chatId: -100}},
      {route: subscriptionsPageRoute, params: {page: 2}},
      {route: payOnchainRoute, params: {chatId: -100123}},
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
      {route: donationPercentRoute, params: {percent: 5}},
      {route: donationScopeRoute, params: {scope: 'all' as const}},
      {route: donationScopeRoute, params: {scope: 'tips' as const}},
      {route: donateAmountRoute, params: {amountSats: 1000}},
      {route: donateMonthlyAmountRoute, params: {amountSats: 100}},
      {route: payLightningRoute, params: {chatId: -100}},
      {
        route: payJoinBalanceRoute,
        params: {chatId: -100123, from: 'wallet' as const},
      },
      {
        route: payJoinBalanceRoute,
        params: {chatId: -100123, from: 'nwc' as const},
      },
      {route: featureFundAmountRoute, params: {amountSats: 500}},
      {route: broadcastLocaleRoute, params: {locale: 'en' as const}},
      {route: broadcastLocaleRoute, params: {locale: 'ru' as const}},
      {route: broadcastConfirmRoute, params: {action: 'yes' as const}},
      {route: broadcastConfirmRoute, params: {action: 'no' as const}},
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
    expect(parameterizedRoutes).toHaveLength(27)
  })

  test('language-specific custom-message routes reject unsupported locales', () => {
    for (const route of [
      chatCustomMessageEditRoute,
      chatCustomMessagePreviewRoute,
      chatCustomMessageResetRoute,
    ]) {
      const invalid = `chat:-5:custom-message:${route.name.split('-').at(-1)}:fr`
      expect(route.pattern.test(invalid)).toBe(false)
      expect(() => route.parse(invalid)).toThrow('Invalid callback data')
    }
  })
})
