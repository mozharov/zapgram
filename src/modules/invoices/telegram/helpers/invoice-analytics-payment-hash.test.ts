import {expect, test} from 'bun:test'
import {mintInvoice} from '../../../../../test/e2e/fakes/bolt11.js'
import {invoiceAnalyticsPaymentHash} from './invoice-analytics-payment-hash.js'

test('uses the mint hash without decoding the payment request', () => {
  expect(invoiceAnalyticsPaymentHash({paymentRequest: 'invalid', paymentHash: 'mint-hash'})).toBe(
    'mint-hash',
  )
})

test('falls back to BOLT11 when the mint does not provide a hash', () => {
  const invoice = mintInvoice({sats: 21})
  expect(invoiceAnalyticsPaymentHash({paymentRequest: invoice.bolt11})).toBe(invoice.paymentHash)
})

test('omits the analytics hash when the fallback cannot decode the invoice', () => {
  expect(invoiceAnalyticsPaymentHash({paymentRequest: 'invalid'})).toBeUndefined()
})
