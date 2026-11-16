import {expect, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {SendPausedError} from '@core/errors/send-paused.js'
import got from 'got'
import {lnurlPayFailureKind} from './paying-invoice.js'

test('a cloned send-paused error is still the pause, and a definite refusal is not a hold', async () => {
  const cloned = {name: 'Error', message: 'send_paused'}
  expect(lnurlPayFailureKind(cloned)).toBe('paused')
  expect(lnurlPayFailureKind(new SendPausedError())).toBe('paused')
  expect(lnurlPayFailureKind(new NWCPaymentFailedError())).toBe('hold')
  expect(lnurlPayFailureKind(new InsufficientFundsError())).toBe('rejected')
  expect(lnurlPayFailureKind(new NWCTimeoutError())).toBe('hold')

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const status = Number(new URL(request.url).pathname.slice(1))
      return Response.json({status: 'failed', detail: 'no route'}, {status})
    },
  })
  try {
    const refused = await got(`http://127.0.0.1:${server.port}/400`, {
      retry: {limit: 0},
      throwHttpErrors: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    const unknown = await got(`http://127.0.0.1:${server.port}/500`, {
      retry: {limit: 0},
      throwHttpErrors: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(lnurlPayFailureKind(refused)).toBe('declined')
    expect(lnurlPayFailureKind(unknown)).toBe('hold')
  } finally {
    server.stop(true)
  }
})
