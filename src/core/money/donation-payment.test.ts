import {expect, test} from 'bun:test'
import {DEFAULT_INVOICE_EXPIRY_SECONDS} from '../lightning/invoice-expiry.js'
import {classifyDonationLookup, donationInvoiceExpiresAt} from './donation-payment.js'

const now = new Date()
const past = new Date(now.getTime() - 1000)
const future = new Date(now.getTime() + 1000)

for (const [expiry, saved, expected] of [
  [past, future, 'retryable'],
  [future, past, 'retryable'],
  [null, past, 'retryable'],
  [future, future, 'pending'],
  [null, future, 'pending'],
  [now, future, 'retryable'],
] as const) {
  test(`unpaid invoice: lookup ${expiry?.getTime()}, saved ${saved.getTime()} -> ${expected}`, () => {
    expect(
      classifyDonationLookup(
        {paid: false, status: 'pending', details: {amount: 50_000, expiry}},
        saved,
        now,
      ),
    ).toBe(expected)
  })
}

test('paid wins over expired TTL; failed never waits for TTL', () => {
  expect(
    classifyDonationLookup({paid: true, details: {amount: 50_000, expiry: past}}, past, now),
  ).toBe('paid')
  expect(
    classifyDonationLookup(
      {paid: false, status: 'failed', details: {amount: 50_000, expiry: future}},
      future,
      now,
    ),
  ).toBe('retryable')
})

test('missing expiry uses the same explicit invoice lifetime as LNbits POST', () => {
  expect(donationInvoiceExpiresAt(null, now).getTime() - now.getTime()).toBe(
    DEFAULT_INVOICE_EXPIRY_SECONDS * 1000,
  )
  expect(donationInvoiceExpiresAt(future, now)).toEqual(future)
})
