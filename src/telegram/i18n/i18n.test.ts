import {describe, expect, test} from 'bun:test'
import {translate} from './i18n.js'

const context = {
  title: 'Test Community',
  expiryDate: new Date('2026-05-01T12:00:00.000Z'),
  price: 1000,
  usdSuffix: '',
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

    test(`subscription-renewal.renewed dates in ${language} are rendered by the client`, () => {
      // Background notifications go through translate(), so they must carry the entity too.
      const message = translate('subscription-renewal.renewed', language, context)
      expect(message).toContain('<tg-time unix="1777636800" format="D">')
      expect(message).not.toContain('UTC)')
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

describe('created lightning invoice copy', () => {
  const expiresAt = new Date('2026-05-01T12:00:00.000Z')

  test('english invoice review created label does not stack another at onto the date entity', () => {
    const message = translate('wait-for-invoice-review', 'en', {
      amount: 1000,
      usdSuffix: '',
      fee: 'no',
      feeUsdSuffix: '',
      description: '',
      hasDescription: 'false',
      createdDate: expiresAt,
      expiryDate: expiresAt,
      hasExpired: 'false',
      invoice: 'lnbc1test',
    })
    expect(message).toContain('Created:')
    expect(message).not.toContain('Created at:')
    expect(message).toContain('<blockquote expandable>')
    expect(message).toContain('<code>lnbc1test</code>')
    expect(message).not.toMatch(/Expires:[\s\S]*?<\/b>\n{3,}<blockquote/)
  })

  test('paid invoice copy names the wallet and does not keep the paying title', () => {
    const message = translate('paying-invoice.paid', 'en', {
      amount: 1000,
      usdSuffix: '',
      fee: 0,
      feeUsdSuffix: '',
      total: 1000,
      totalUsdSuffix: '',
      wallet: 'internal',
      description: 'coffee',
      hasDescription: 'true',
      invoice: 'lnbc1test',
    })
    expect(message).toContain('✅ Invoice paid.')
    expect(message).not.toContain('Paying Lightning invoice')
    expect(message).toContain('Wallet: <b>ZapGram</b>')
    expect(message).toContain('Description: <b>coffee</b>')
    expect(message).toContain('<blockquote expandable>')
  })

  test('english expiry label does not stack another at onto the date entity', () => {
    const message = translate('creating-invoice.created', 'en', {
      amount: 1000,
      usdSuffix: '',
      wallet: 'internal',
      hasDescription: 'false',
      description: '',
      expiresAt,
      invoice: 'lnbc1test',
    })
    expect(message).toContain('Expires:')
    expect(message).not.toContain('Expires at:')
    expect(message).toContain('<blockquote expandable>')
    expect(message).toMatch(/<\/b>\n+Wallet: <b>ZapGram<\/b>/)
    expect(message).toContain('<code>lnbc1test</code>')
  })
})

describe('subscription invoice remaining time', () => {
  // The countdown is the client's job now: a relative date_time entity keeps ticking after the
  // message is sent, which hand-counted hours and minutes could not.
  const expiresAt = new Date('2026-05-01T12:00:00.000Z')

  test.each([
    ['en', 'The invoice expires'],
    ['ru', 'Счёт истекает'],
  ])('%s hands the expiry to the client to count down', (language, expected) => {
    const message = translate('subscription-invoice.remaining-time', language, {expiresAt})
    expect(message).toContain(expected)
    expect(message).toContain('<tg-time unix="1777636800" format="r">')
  })
})

describe('duplicate subscription refund', () => {
  test.each([
    ['en', 'A repeated subscription payment of 1,000 sats was credited'],
    ['ru', 'Повторный платёж за подписку на 1 000 сат зачислен'],
  ])('resolves the confirmed refund message in %s', (language, expected) => {
    expect(
      translate('subscription-invoice.duplicate-refunded', language, {price: 1000, usdSuffix: ''}),
    ).toContain(expected)
  })
})

describe('stored Telegram language tags', () => {
  test.each([
    ['ru', /Повторный платёж/],
    ['ru-RU', /Повторный платёж/],
    ['en', /A repeated subscription payment/],
    ['en-US', /A repeated subscription payment/],
    ['sr-Latn', /A repeated subscription payment/],
    ['not_a_tag', /A repeated subscription payment/],
  ])('normalizes %s for background notifications', (language, expected) => {
    expect(
      translate('subscription-invoice.duplicate-refunded', language, {price: 1000, usdSuffix: ''}),
    ).toMatch(expected)
  })

  test('uses English when a background notification has no stored tag', () => {
    expect(
      translate('subscription-invoice.duplicate-refunded', undefined, {price: 1000, usdSuffix: ''}),
    ).toMatch(/A repeated subscription payment/)
  })
})
