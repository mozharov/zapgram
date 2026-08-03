import {describe, expect, test} from 'bun:test'
import {translate} from './i18n.js'

const context = {
  title: 'Test Community',
  expiryDate: new Date('2026-05-01T12:00:00.000Z'),
  price: 1000,
}

describe('settlement messages', () => {
  // Fluent renders the key path itself when a key is missing, so a typo would silently ship
  // "subscription-renewal.renewed" to subscribers instead of a message.
  for (const language of ['en', 'ru']) {
    test(`subscription-renewal.renewed resolves in ${language}`, () => {
      const message = translate('subscription-renewal.renewed', language, context)
      expect(message).not.toContain('subscription-renewal')
      expect(message).toContain('Test Community')
      expect(message).toContain('2026') // the expiry date actually rendered
      expect(message).toMatch(/1\D?000/) // Fluent groups digits per locale: "1,000" / "1 000"
    })

    test(`subscription-invoice.expired resolves in ${language}`, () => {
      const message = translate('subscription-invoice.expired', language)
      expect(message).not.toContain('subscription-invoice')
    })
  }

  test('the renewal message does not claim the renewal was automatic', () => {
    // Also sent when a subscriber pays a renewal invoice by hand.
    expect(translate('subscription-renewal.renewed', 'en', context)).not.toContain('automatic')
    expect(translate('subscription-renewal.renewed', 'ru', context)).not.toContain('автоматич')
  })

  test('renewal and first-access messages are distinct', () => {
    const renewed = translate('subscription-renewal.renewed', 'en', context)
    const joined = translate('subscription-invoice.paid', 'en', {
      title: context.title,
      type: 'monthly',
    })
    expect(renewed).not.toBe(joined)
    expect(joined).toContain('Access')
  })
})

describe('subscription invoice remaining time', () => {
  test.each([
    ['en', 0, 1, '1 minute'],
    ['en', 1, 0, '1 hour'],
    ['en', 23, 59, '23 hours and 59 minutes'],
    ['ru', 0, 1, '1 минуту'],
    ['ru', 2, 0, '2 часа'],
    ['ru', 5, 21, '5 часов и 21 минуту'],
  ])('%s renders %s hours and %s minutes', (language, hours, minutes, expected) => {
    const message = translate('subscription-invoice.remaining-time', language, {hours, minutes})
    expect(message).toContain(expected)
  })
})

describe('duplicate subscription refund', () => {
  test.each([
    ['en', 'A repeated subscription payment of 1,000 sats was credited'],
    ['ru', 'Повторный платёж за подписку на 1 000 сат зачислен'],
  ])('resolves the confirmed refund message in %s', (language, expected) => {
    expect(translate('subscription-invoice.duplicate-refunded', language, {price: 1000})).toContain(
      expected,
    )
  })
})
