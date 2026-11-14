import {expect, test} from 'bun:test'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import type {PayoutState} from '@core/payments/payout-state.js'
import type {AppLogger} from '@infra/logger.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createLnurlPayAttemptRepository} from './lnurl-pay-attempt.repository.js'
import {createLnurlPayAttemptService} from './lnurl-pay-attempt.service.js'

const log = {info() {}, error() {}, warn() {}, debug() {}} as unknown as AppLogger

const attempt = {
  fromUserId: 1,
  recipient: 'alice@pay.example',
  sats: 30,
  rail: 'internal' as const,
  paymentHash: 'hash-1',
  bolt11: 'lnbc1',
}

test('an unclear LNURL pay blocks a second debit to the same recipient', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  let pays = 0
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async () => 'unknown' satisfies PayoutState | 'unknown',
  })

  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  pays += 1
  try {
    throw new NWCTimeoutError()
  } catch {
    // The wallet call timed out. The row stays pay_unknown. Nothing settles it.
  }
  expect(pays).toBe(1)

  expect(await service.hasUnresolved(1, attempt.recipient)).toBe(true)
  expect(await service.beginPay({...attempt, attemptId: 'two', paymentHash: 'hash-2'})).toBe(
    'blocked',
  )
  expect(pays).toBe(1)
  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('in_flight')
  expect(pays).toBe(1)
})
