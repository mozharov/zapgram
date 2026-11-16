import {expect, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import {HTTPError} from 'got'
import {lnurlPayFailureKind} from './paying-invoice.js'

test('a cloned pause is recognized and uncertain wallet outcomes stay on hold', () => {
  expect(lnurlPayFailureKind({name: 'Error', message: 'send_paused'})).toBe('paused')
  expect(lnurlPayFailureKind(new SendPausedError())).toBe('paused')
  expect(lnurlPayFailureKind(new NWCPaymentFailedError())).toBe('hold')
  expect(lnurlPayFailureKind(new InsufficientFundsError())).toBe('rejected')
  expect(lnurlPayFailureKind(new NWCTimeoutError())).toBe('hold')
  expect(lnurlPayFailureKind(new PaymentPendingError())).toBe('hold')
})

for (const {statusCode, status, expected} of [
  {statusCode: 400, status: 'failed', expected: 'declined'},
  {statusCode: 500, status: 'failed', expected: 'hold'},
  {statusCode: 520, status: 'failed', expected: 'declined'},
  {statusCode: 520, status: 'pending', expected: 'hold'},
  {statusCode: 520, status: 'success', expected: 'hold'},
] as const) {
  test(`LNbits ${statusCode} ${status} means ${expected}`, () => {
    const error = Object.assign(Object.create(HTTPError.prototype) as HTTPError, {
      response: {statusCode, body: {status, detail: 'provider response'}},
    })
    expect(lnurlPayFailureKind(error)).toBe(expected)
  })
}
