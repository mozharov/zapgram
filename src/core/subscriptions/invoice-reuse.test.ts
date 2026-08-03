import {describe, expect, test} from 'bun:test'
import {decideInvoiceReuse, MIN_REUSABLE_INVOICE_REMAINING_MS} from './invoice-reuse.js'

describe('decideInvoiceReuse', () => {
  const now = new Date('2026-08-03T12:00:00.000Z')

  test('reuses an invoice with exactly one hour remaining', () => {
    expect(
      decideInvoiceReuse({
        expiryDate: new Date(now.getTime() + MIN_REUSABLE_INVOICE_REMAINING_MS),
        now,
      }),
    ).toEqual({action: 'reuse', remainingMinutes: 60})
  })

  test('replaces an invoice with 59:59 remaining', () => {
    expect(
      decideInvoiceReuse({
        expiryDate: new Date(now.getTime() + MIN_REUSABLE_INVOICE_REMAINING_MS - 1000),
        now,
      }),
    ).toEqual({action: 'replace', reason: 'expires_soon'})
  })

  test('rounds remaining time down to whole minutes', () => {
    expect(
      decideInvoiceReuse({
        expiryDate: new Date(now.getTime() + 119 * 60_000 + 59_999),
        now,
      }),
    ).toEqual({action: 'reuse', remainingMinutes: 119})
  })

  test('replaces an invoice that expires exactly now', () => {
    expect(decideInvoiceReuse({expiryDate: now, now})).toEqual({
      action: 'replace',
      reason: 'expired',
    })
  })

  test('replaces an already expired invoice', () => {
    expect(
      decideInvoiceReuse({
        expiryDate: new Date(now.getTime() - 1),
        now,
      }),
    ).toEqual({action: 'replace', reason: 'expired'})
  })

  test('replaces an invoice without an expiry', () => {
    expect(decideInvoiceReuse({expiryDate: undefined, now})).toEqual({
      action: 'replace',
      reason: 'missing_expiry',
    })
    expect(decideInvoiceReuse({expiryDate: null, now})).toEqual({
      action: 'replace',
      reason: 'missing_expiry',
    })
  })

  test('replaces an invoice when either timestamp is invalid', () => {
    expect(decideInvoiceReuse({expiryDate: new Date(Number.NaN), now})).toEqual({
      action: 'replace',
      reason: 'invalid_time',
    })
    expect(
      decideInvoiceReuse({
        expiryDate: new Date('2026-08-03T14:00:00.000Z'),
        now: new Date(Number.NaN),
      }),
    ).toEqual({action: 'replace', reason: 'invalid_time'})
  })
})
