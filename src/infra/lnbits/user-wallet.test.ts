import {expect, mock, test} from 'bun:test'
import type {AppConfig} from '@config'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import {HTTPError} from 'got'
import type {ZodType} from 'zod'
import {createMasterWallet} from './master-wallet.js'
import type {OutgoingLiquidityGuard} from './outgoing-liquidity.js'
import {UserWallet} from './user-wallet.js'

const response = {
  checking_id: 'check',
  payment_hash: 'hash',
  wallet_id: 'wallet',
  amount: -21_000,
  fee: 0,
  bolt11: 'bolt11',
  time: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
}

class TestUserWallet extends UserWallet {
  result: unknown = response
  error?: Error

  protected override async fetchWithSchema<T>(_path: string, schema: ZodType<T>): Promise<T> {
    if (this.error) throw this.error
    return schema.parse(this.result)
  }
}

for (const status of ['pending', 'failed', 'unexpected', undefined]) {
  test(`a 201 ${status ?? 'missing status'} is unknown and keeps the liquidity spent`, async () => {
    const hold = {msat: 21_000, generation: 1, paymentHash: 'hash', walletId: 'wallet'}
    const guard = {
      assertCanPay: mock(async () => hold),
      settle: mock(async () => {}),
      release: mock(async () => {}),
      abandon: mock(async () => {}),
      invalidate: mock(async () => {}),
    } satisfies OutgoingLiquidityGuard
    const wallet = new TestUserWallet(
      'test-key',
      100_000,
      'http://unused',
      '',
      undefined,
      undefined,
      guard,
    )
    wallet.result = {...response, status}
    await expect(wallet.payInvoice('bolt11')).rejects.toBeInstanceOf(PaymentPendingError)
    expect(guard.abandon).toHaveBeenCalledWith(hold)
    expect(guard.settle).not.toHaveBeenCalled()
    expect(guard.release).not.toHaveBeenCalled()
    expect(guard.invalidate).not.toHaveBeenCalled()
  })
}

test('a repeated pending payment (520) stays unknown', async () => {
  const wallet = new TestUserWallet('test-key', 100_000, 'http://unused')
  wallet.error = Object.assign(Object.create(HTTPError.prototype) as HTTPError, {
    response: {statusCode: 520, body: {status: 'pending', detail: 'Payment is still pending.'}},
  })
  await expect(wallet.payInvoice('bolt11')).rejects.toBeInstanceOf(PaymentPendingError)
})

test('a success is returned to the caller', async () => {
  const wallet = new TestUserWallet('test-key', 100_000, 'http://unused')
  wallet.result = {...response, status: 'success'}
  expect((await wallet.payInvoice('bolt11')).status).toBe('success')
})

test('the master wallet also refuses an uncertain payout response', async () => {
  const wallet = createMasterWallet({
    LNBITS_URL: 'http://unused',
    LNBITS_ADMIN_KEY: 'test-key',
    LNBITS_FEE_COLLECTION_INVOICE_KEY: 'fee-key',
    HOST: 'https://unused',
    BOT_WEBHOOK_SECRET: 'test',
  } as AppConfig)
  Reflect.set(wallet, 'fetchWithSchema', async <T>(_path: string, schema: ZodType<T>) =>
    schema.parse({...response, status: 'pending'}),
  )
  await expect(wallet.payInvoice('bolt11', {knownInternal: true})).rejects.toBeInstanceOf(
    PaymentPendingError,
  )
})
