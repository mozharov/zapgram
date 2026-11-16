import {expect, test} from 'bun:test'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
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

test('two settles of one LNURL pay collect the donation once', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  let donations = 0
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async () => ({state: 'unknown' as const}),
    collectDonation: async () => {
      donations += 1
      await gate
    },
  })
  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  const first = service.notePaid('one', attempt.paymentHash, true)
  await Bun.sleep(20)
  const second = service.notePaid('one', attempt.paymentHash, true)
  release()
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(donations).toBe(1)
})

test('recovery does not abandon an invoice after pay has started', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  const started = new Date('2026-01-01T00:00:00Z')
  let now = started
  const attempts = createLnurlPayAttemptRepository(db)
  const notices: string[] = []
  const realAbandon = attempts.abandonIfPhase.bind(attempts)
  attempts.abandonIfPhase = async (id, expected) => {
    await attempts.markPhase(id, 'pay_unknown', 'invoice_saved')
    return realAbandon(id, expected)
  }
  const service = createLnurlPayAttemptService({
    attempts,
    log,
    now: () => now,
    lookup: async () => ({state: 'unknown' as const}),
    notifySender: async ({outcome}) => {
      notices.push(outcome)
      return true
    },
  })
  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  expect(await attempts.markPhase('one', 'invoice_saved', 'pay_unknown')).toBeDefined()
  now = new Date(started.getTime() + 3 * 60_000)
  expect(await service.reconcile('one')).toBe('in_flight')
  expect(notices).toEqual([])
  expect((await attempts.get('one')).phase).toBe('pay_unknown')
})

test('an unclear LNURL pay blocks a second debit to the same recipient', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  let pays = 0
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async () => ({state: 'unknown' as const}),
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

test('an already-paid invoice is a receipt only when this wallet paid it', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  let looked: {state: 'retryable' | 'paid'; paidAt?: Date} = {state: 'retryable'}
  let donations = 0
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async () => looked,
    collectDonation: async () => {
      donations += 1
    },
  })

  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  expect(await service.resolveAlreadyPaid('one')).toBe('absent')
  expect(donations).toBe(0)
  expect((await createLnurlPayAttemptRepository(db).get('one')).phase).toBe('abandoned')

  looked = {state: 'paid', paidAt: new Date()}
  expect(await service.beginPay({...attempt, attemptId: 'two', paymentHash: 'hash-2'})).toBe(
    'ready',
  )
  expect(await service.resolveAlreadyPaid('two')).toBe('paid')
  expect(donations).toBe(1)
  expect((await createLnurlPayAttemptRepository(db).get('two')).status).toBe('settled')
})

test('a prior payment of the same invoice does not settle a new attempt', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  let donations = 0
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async () => ({state: 'paid' as const, paidAt: new Date(Date.now() - 60_000)}),
    collectDonation: async () => {
      donations += 1
    },
  })

  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  expect(await service.readPay('one')).toBe('prior')
  expect(await service.resolveAlreadyPaid('one')).toBe('absent')
  expect(donations).toBe(0)
  expect((await createLnurlPayAttemptRepository(db).get('one')).phase).toBe('abandoned')
  expect((await createLnurlPayAttemptRepository(db).get('one')).status).toBe('pending')
})

test('a second attempt cannot collect a donation for a hash already settled', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  let donations = 0
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    lookup: async () => ({state: 'paid' as const, paidAt: new Date()}),
    collectDonation: async () => {
      donations += 1
    },
  })

  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  expect(await service.notePaid('one', attempt.paymentHash, true)).toBe(true)
  expect(donations).toBe(1)

  expect(
    await service.beginPay({
      ...attempt,
      attemptId: 'two',
      recipient: 'bob@pay.example',
    }),
  ).toBe('ready')
  expect(await service.readPay('two')).toBe('prior')
  expect(await service.resolveAlreadyPaid('two')).toBe('absent')
  expect(donations).toBe(1)
  expect((await createLnurlPayAttemptRepository(db).get('two')).phase).toBe('abandoned')
  expect((await createLnurlPayAttemptRepository(db).get('one')).status).toBe('settled')
})

test('a paid lookup without a time does not become a receipt', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  const started = new Date('2026-01-01T00:00:00Z')
  let now = started
  let donations = 0
  const service = createLnurlPayAttemptService({
    attempts: createLnurlPayAttemptRepository(db),
    log,
    now: () => now,
    payReviewMs: 1_000,
    lookup: async () => ({state: 'paid' as const}),
    collectDonation: async () => {
      donations += 1
    },
  })

  expect(await service.beginPay({...attempt, attemptId: 'one'})).toBe('ready')
  expect(await service.readPay('one')).toBe('ambiguous')
  expect(await service.resolveAlreadyPaid('one')).toBe('hold')
  expect(await service.reconcile('one')).toBe('in_flight')
  expect(donations).toBe(0)
  expect((await createLnurlPayAttemptRepository(db).get('one')).phase).toBe('pay_unknown')

  now = new Date(started.getTime() + 1_001)
  expect(await service.reconcile('one')).toBe('needs_review')
  expect(donations).toBe(0)
  expect((await createLnurlPayAttemptRepository(db).get('one')).phase).toBe('needs_review')
  expect((await createLnurlPayAttemptRepository(db).get('one')).status).toBe('pending')
})
