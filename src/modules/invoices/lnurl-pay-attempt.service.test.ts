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

for (const mismatch of [{fromUserId: 2}, {recipient: 'bob@pay.example'}, {sats: 31}]) {
  test(`mismatched LNURL attempt data ${JSON.stringify(mismatch)} does not mean in flight`, async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    await users.getOrCreate({id: 1, languageCode: 'en'})
    await users.getOrCreate({id: 2, languageCode: 'en'})
    const attempts = createLnurlPayAttemptRepository(db)
    const service = createLnurlPayAttemptService({
      attempts,
      log,
      lookup: async () => {
        throw new Error('A mismatched attempt must not look up a payment')
      },
    })
    await attempts.reserve({...attempt, id: 'original'})
    const before = await attempts.get('original')
    expect(await service.beginPay({...attempt, ...mismatch, attemptId: 'original'})).toBe(
      'not_started',
    )
    expect(await attempts.get('original')).toEqual(before)
  })
}

test('an abandoned LNURL attempt is not presented as an unresolved payment', async () => {
  const db = createTestDb()
  await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
  const attempts = createLnurlPayAttemptRepository(db)
  let notices = 0
  const service = createLnurlPayAttemptService({
    attempts,
    log,
    lookup: async () => ({state: 'unknown'}),
    notifySender: async () => {
      notices += 1
      return true
    },
  })
  await service.beginPay({...attempt, attemptId: 'abandoned'})
  await service.noteRejected('abandoned')
  expect(await service.beginPay({...attempt, attemptId: 'abandoned'})).toBe('not_started')
  await service.reconcile('abandoned')
  expect(notices).toBe(0)
  expect(await service.listActionable(20, 0)).toEqual([])
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

for (const final of ['paid', 'retryable'] as const) {
  test(`needs_review retries its notice and later tells the LNURL sender ${final}`, async () => {
    const db = createTestDb()
    await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
    const attempts = createLnurlPayAttemptRepository(db)
    let now = new Date()
    let state: 'pending' | 'paid' | 'retryable' = 'pending'
    let deliver = false
    let donations = 0
    const notices: string[] = []
    const service = createLnurlPayAttemptService({
      attempts,
      log,
      now: () => now,
      payReviewMs: 1_000,
      lookup: async () => ({state, ...(state === 'paid' ? {paidAt: now} : {})}),
      collectDonation: async () => {
        donations += 1
      },
      notifySender: async ({outcome}) => {
        notices.push(outcome)
        return deliver
      },
    })
    await service.beginPay({...attempt, attemptId: 'review'})
    now = new Date(now.getTime() + 2_000)
    expect(await service.reconcile('review')).toBe('needs_review')
    expect((await attempts.get('review')).senderNotified).toBe(false)
    expect((await service.listActionable(20, 0)).map(row => row.id)).toEqual(['review'])
    deliver = true
    await service.reconcile('review')
    expect((await attempts.get('review')).reviewNotified).toBe(true)
    expect((await attempts.get('review')).senderNotified).toBe(false)
    expect(await service.listActionable(20, 0)).toEqual([])
    now = new Date(now.getTime() + 60 * 60_000 + 1_000)
    expect((await service.listActionable(20, 0)).map(row => row.id)).toEqual(['review'])
    state = final
    expect(await service.reconcile('review')).toBe(final === 'paid' ? 'settled' : 'abandoned')
    expect(notices).toEqual([
      'needs_review',
      'needs_review',
      final === 'paid' ? 'settled' : 'abandoned',
    ])
    expect(donations).toBe(final === 'paid' ? 1 : 0)
    expect(await service.listActionable(20, 0)).toEqual([])
    const before = await attempts.get('review')
    expect(await attempts.markNeedsReview('review')).toBe(false)
    expect(await attempts.get('review')).toEqual(before)
  })
}

for (const phase of ['reserved', 'invoice_saved', 'pay_unknown'] as const) {
  test(`an undelivered abandoned LNURL ${phase} notice is retried until delivered`, async () => {
    const db = createTestDb()
    await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
    const attempts = createLnurlPayAttemptRepository(db)
    let now = new Date()
    let tries = 0
    const service = createLnurlPayAttemptService({
      attempts,
      log,
      now: () => now,
      invoiceGraceMs: 1_000,
      payReviewMs: 1_000,
      lookup: async () => ({state: 'retryable'}),
      notifySender: async () => {
        tries += 1
        if (tries === 1) throw new Error('Telegram unavailable')
        return true
      },
    })
    await attempts.reserve({...attempt, id: 'abandon', createdAt: now})
    if (phase !== 'reserved')
      await attempts.saveInvoice('abandon', null, {hash: 'abandon', bolt11: 'bolt'})
    if (phase === 'pay_unknown') await attempts.markPhase('abandon', 'pay_unknown', 'invoice_saved')
    now = new Date(now.getTime() + 2_000)
    expect(await service.reconcile('abandon')).toBe('abandoned')
    expect((await service.listActionable(20, 0)).map(row => row.id)).toEqual(['abandon'])
    await service.reconcile('abandon')
    expect(tries).toBe(2)
    expect(await service.listActionable(20, 0)).toEqual([])
  })
}

test('markNeedsReview only claims an unresolved LNURL pay', async () => {
  const db = createTestDb()
  await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
  const attempts = createLnurlPayAttemptRepository(db)
  await attempts.reserve({...attempt, id: 'guard'})
  expect(await attempts.markNeedsReview('guard')).toBe(false)
  await attempts.saveInvoice('guard', null, {hash: 'guard', bolt11: 'bolt'})
  await attempts.markPhase('guard', 'pay_unknown', 'invoice_saved')
  await attempts.markProviderAccepted('guard', 'guard')
  expect(await attempts.markNeedsReview('guard')).toBe(false)
  await attempts.markSettled('guard')
  expect(await attempts.markNeedsReview('guard')).toBe(false)
  expect((await attempts.get('guard')).phase).toBe('settled')
})

test('a wizard rejection is not announced again by LNURL recovery', async () => {
  const db = createTestDb()
  await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
  const attempts = createLnurlPayAttemptRepository(db)
  let notices = 0
  const service = createLnurlPayAttemptService({
    attempts,
    log,
    lookup: async () => ({state: 'retryable'}),
    notifySender: async () => {
      notices += 1
      return true
    },
  })
  await service.beginPay({...attempt, attemptId: 'refused'})
  await service.noteRejected('refused')
  expect((await attempts.get('refused')).senderNotified).toBe(true)
  await service.reconcile('refused')
  await service.reconcile('refused')
  expect(notices).toBe(0)
  expect(await service.listActionable(20, 0)).toEqual([])
  expect(await service.hasUnresolved(1, attempt.recipient)).toBe(false)
})
for (const lookup of ['retryable', 'prior', 'claimed'] as const) {
  test(`wizard already-paid resolution (${lookup}) does not send a second refusal`, async () => {
    const db = createTestDb()
    await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
    const attempts = createLnurlPayAttemptRepository(db)
    let notices = 0
    let donations = 0
    const service = createLnurlPayAttemptService({
      attempts,
      log,
      lookup: async () =>
        lookup === 'retryable'
          ? {state: 'retryable'}
          : {state: 'paid', paidAt: new Date(Date.now() - (lookup === 'prior' ? 60_000 : 0))},
      notifySender: async () => {
        notices += 1
        return true
      },
      collectDonation: async () => {
        donations += 1
      },
    })
    if (lookup === 'claimed') {
      await service.beginPay({...attempt, attemptId: 'owner', recipient: 'owner@pay.example'})
      await service.notePaid('owner', attempt.paymentHash, true)
    }
    await service.beginPay({...attempt, attemptId: 'refused'})
    expect(await service.resolveAlreadyPaid('refused')).toBe('absent')
    expect((await attempts.get('refused')).senderNotified).toBe(true)
    await service.reconcile('refused')
    expect(notices).toBe(0)
    expect(donations).toBe(lookup === 'claimed' ? 1 : 0)
    expect(await service.listActionable(20, 0)).toEqual([])
  })
}

for (const race of [false, true]) {
  test(`wizard notePaid losing the invoice ${race ? 'during settle' : 'before settle'} is already notified`, async () => {
    const db = createTestDb()
    await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
    const attempts = createLnurlPayAttemptRepository(db)
    let notices = 0
    let donations = 0
    const service = createLnurlPayAttemptService({
      attempts,
      log,
      lookup: async () => ({state: 'unknown'}),
      notifySender: async () => {
        notices += 1
        return true
      },
      collectDonation: async () => {
        donations += 1
      },
    })
    await service.beginPay({...attempt, attemptId: 'owner', recipient: 'owner@pay.example'})
    await service.beginPay({...attempt, attemptId: 'loser'})
    if (race) {
      const mark = attempts.markSettled.bind(attempts)
      attempts.markSettled = async (id, senderNotified) => {
        if (id === 'loser') await service.notePaid('owner', attempt.paymentHash, true)
        return mark(id, senderNotified)
      }
    } else await service.notePaid('owner', attempt.paymentHash, true)
    expect(await service.notePaid('loser', attempt.paymentHash, true)).toBe(false)
    expect((await attempts.get('loser')).phase).toBe('abandoned')
    expect((await attempts.get('loser')).senderNotified).toBe(true)
    await service.reconcile('loser')
    expect(notices).toBe(0)
    expect(donations).toBe(1)
    expect(await service.listActionable(20, 0)).toEqual([])
  })
}

test('LNURL settle cannot resurrect an abandoned attempt or collect a donation', async () => {
  const db = createTestDb()
  await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
  const attempts = createLnurlPayAttemptRepository(db)
  let donations = 0
  const service = createLnurlPayAttemptService({
    attempts,
    log,
    lookup: async () => ({state: 'unknown'}),
    collectDonation: async () => {
      donations += 1
    },
  })
  await service.beginPay({...attempt, attemptId: 'abandoned'})
  await service.noteRejected('abandoned')
  expect(await service.notePaid('abandoned', attempt.paymentHash)).toBe(false)
  expect((await attempts.get('abandoned')).phase).toBe('abandoned')
  expect(donations).toBe(0)
})

test('an LNURL invoice losing the open-attempt index is closed without a recovery notice', async () => {
  const db = createTestDb()
  await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
  const attempts = createLnurlPayAttemptRepository(db)
  let notices = 0
  const service = createLnurlPayAttemptService({
    attempts,
    log,
    lookup: async () => ({state: 'unknown'}),
    notifySender: async () => {
      notices += 1
      return true
    },
  })
  const ids = ['first', 'second']
  const results = await Promise.all(ids.map(attemptId => service.beginPay({...attempt, attemptId})))
  expect(results.filter(result => result === 'ready')).toHaveLength(1)
  expect(results.filter(result => result === 'blocked')).toHaveLength(1)
  const blockedId = ids[results.indexOf('blocked')]
  if (!blockedId) throw new Error('missing blocked attempt')
  expect((await attempts.get(blockedId)).phase).toBe('abandoned')
  expect((await attempts.get(blockedId)).senderNotified).toBe(true)
  await service.reconcile(blockedId)
  expect(notices).toBe(0)
  // Once the competing payment resolves, this abandoned invoice still cannot pay.
  const readyId = ids[results.indexOf('ready')]
  if (!readyId) throw new Error('missing ready attempt')
  await service.noteRejected(readyId)
  expect(await service.beginPay({...attempt, attemptId: blockedId})).toBe('not_started')
  await service.reconcile(blockedId)
  expect(notices).toBe(0)
  expect(await service.listActionable(20, 0)).toEqual([])
})

for (const phase of ['pay_unknown', 'provider_accepted'] as const) {
  test(`recovery still notifies a ${phase} LNURL attempt losing its invoice claim`, async () => {
    const db = createTestDb()
    await createUserRepository(db).getOrCreate({id: 1, languageCode: 'en'})
    const attempts = createLnurlPayAttemptRepository(db)
    const notices: string[] = []
    let deliver = false
    const service = createLnurlPayAttemptService({
      attempts,
      log,
      lookup: async () => ({state: 'paid', paidAt: new Date()}),
      notifySender: async ({outcome}) => {
        notices.push(outcome)
        return deliver
      },
    })
    await service.beginPay({...attempt, attemptId: 'owner', recipient: 'owner@pay.example'})
    await service.notePaid('owner', attempt.paymentHash, true)
    await service.beginPay({...attempt, attemptId: 'loser'})
    if (phase === 'provider_accepted')
      await attempts.markProviderAccepted('loser', attempt.paymentHash)
    expect(await service.reconcile('loser')).toBe('abandoned')
    expect((await attempts.get('loser')).senderNotified).toBe(false)
    expect((await service.listActionable(20, 0)).map(row => row.id)).toEqual(['loser'])
    deliver = true
    await service.reconcile('loser')
    expect(notices).toEqual(['abandoned', 'abandoned'])
    expect(await service.listActionable(20, 0)).toEqual([])
  })
}
