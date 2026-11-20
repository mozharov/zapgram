import {expect, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {PaymentPendingError} from '@core/errors/payment-pending.js'
import type {PayoutState} from '@core/payments/payout-state.js'
import type {AppLogger} from '@infra/logger.js'
import {createDmTransferRepository} from '@modules/tipping/dm-transfer.repository.js'
import {createDmTransferService, type DmTransferDeps} from '@modules/tipping/dm-transfer.service.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

const log = {
  info() {},
  error() {},
  debug() {},
  warn() {},
  child() {
    return this
  },
} as unknown as AppLogger

type Stored = {hash: string; bolt11: string; paid: boolean; kind: 'user' | 'fee'}

const send = {
  attemptId: 'attempt-1',
  fromUserId: 1,
  toUserId: 2,
  sats: 21,
  rail: 'internal' as const,
}

test('two workers settling one attempt pay the recipient and the donation once', async () => {
  const world = await worldFor({donationPercent: 10})
  await Promise.all([world.service.settle(send), world.service.settle(send)])
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.donations).toHaveLength(1)
})

test('a second send waits while the first pay is unresolved', async () => {
  const world = await worldFor({donationPercent: 0})
  world.payImpl = async () => {
    throw new NWCTimeoutError()
  }
  expect(await world.service.settle(send)).toEqual({outcome: 'in_flight'})
  const again = await world.service.settle({...send, attemptId: 'attempt-2'})
  expect(again).toEqual({outcome: 'blocked'})
  expect(world.created('user')).toBe(1)
  expect(world.payCalls).toBe(0)
})

test('recovery does not abandon a DM invoice after pay has started', async () => {
  const world = await worldFor({donationPercent: 0, invoiceGraceMs: 1_000})
  const created = new Date('2026-01-01T00:00:00Z')
  world.now = () => created
  const row = await world.transfers.reserve({...send, id: send.attemptId, createdAt: created})
  await world.transfers.saveInvoice(row.id, null, {hash: 'saved', bolt11: 'saved'})
  const real = world.transfers.abandonIfPhase.bind(world.transfers)
  world.transfers.abandonIfPhase = async (id, expected) => {
    await world.transfers.markPhase(id, 'pay_unknown', 'invoice_saved')
    return real(id, expected)
  }
  world.now = () => new Date(created.getTime() + 60_000)
  expect(await world.service.reconcile(send.attemptId)).toBe('in_flight')
  expect((await world.transfers.get(send.attemptId)).phase).toBe('pay_unknown')
})

test('two workers settling one attempt pay the recipient once', async () => {
  const world = await worldFor({donationPercent: 0})
  let notices = 0
  world.notify = async () => {
    notices += 1
    return true
  }
  const [first, second] = await Promise.all([
    world.service.settle(send),
    world.service.settle(send),
  ])
  expect(world.paid('user')).toHaveLength(1)
  expect(notices).toBe(1)
  expect(first.outcome === 'settled' || second.outcome === 'settled').toBe(true)
  expect(
    [first.outcome, second.outcome].every(
      outcome => outcome === 'settled' || outcome === 'in_flight',
    ),
  ).toBe(true)

  const again = await world.service.settle(send)
  expect(again).toMatchObject({outcome: 'settled', fee: 'skipped', notice: 'sent'})
  expect(world.paid('user')).toHaveLength(1)
  expect(world.payCalls).toBe(1)
})

test('a lost notice claim does not report the notice as sent', async () => {
  const world = await worldFor({donationPercent: 0})
  let release: (sent: boolean) => void = () => {}
  const gate = new Promise<boolean>(resolve => {
    release = resolve
  })
  let calls = 0
  world.notify = () => {
    calls += 1
    return gate
  }
  const winner = world.service.settle(send)
  await Bun.sleep(50)
  expect(calls).toBe(1)
  world.notify = async () => {
    calls += 1
    return true
  }
  const loser = await world.service.settle(send)
  expect(loser).toMatchObject({outcome: 'settled', notice: 'failed'})
  expect(calls).toBe(1)
  release(false)
  expect(await winner).toMatchObject({outcome: 'settled', notice: 'failed'})
  expect(world.payCalls).toBe(1)

  world.notify = async () => {
    calls += 1
    return true
  }
  const retried = await world.service.settle(send)
  expect(retried).toMatchObject({outcome: 'settled', notice: 'sent'})
  expect(calls).toBe(2)
  expect(world.payCalls).toBe(1)
})

test('an expired notice lease can send once', async () => {
  const world = await worldFor({donationPercent: 0, noticeLeaseMs: 1_000})
  let now = new Date('2026-01-01T00:00:00Z')
  world.now = () => now
  let calls = 0
  world.notify = async () => {
    calls += 1
    return false
  }
  // Claim, fail, release. Then a crash-style claim is simulated by claiming and
  // moving the clock past the lease without a release.
  await world.service.settle(send)
  expect(calls).toBe(1)
  const claimed = await world.transfers.claimNotice(send.attemptId, now, 1_000)
  expect(claimed).toBe(true)
  const blocked = await world.transfers.claimNotice(send.attemptId, now, 1_000)
  expect(blocked).toBe(false)
  now = new Date(now.getTime() + 5_000)
  world.notify = async () => {
    calls += 1
    return true
  }
  const retried = await world.service.settle(send)
  expect(retried).toMatchObject({notice: 'sent'})
  expect(calls).toBe(2)
  expect(world.payCalls).toBe(1)
})

test('a provider acceptance settles even when the lookup then fails', async () => {
  const world = await worldFor({donationPercent: 0})
  world.lookupRecipient = async () => {
    throw new Error('lookup down')
  }
  const result = await world.service.settle(send)
  expect(result).toMatchObject({outcome: 'settled'})
  expect(world.payCalls).toBe(1)
  expect(world.created('user')).toBe(1)

  world.lookupRecipient = async (_to, hash) => world.lookup(hash)
  const again = await world.service.settle(send)
  expect(again.outcome).toBe('settled')
  expect(world.payCalls).toBe(1)
  expect(world.created('user')).toBe(1)
})

for (const answer of ['success', 'already_paid'] as const) {
  for (const state of ['pending', 'retryable', 'unknown'] as const) {
    for (const recovery of ['observe', 'reconcile'] as const) {
      test(`NWC ${answer} with ${state} lookup waits for trusted receipt (${recovery})`, async () => {
        const world = await worldFor({donationPercent: 10})
        const input = {...send, rail: 'nwc' as const}
        let primaryCalls = 0
        let feeCalls = 0
        let notices = 0
        world.notify = async () => {
          notices += 1
          return true
        }
        world.lookupRecipient = async (to, hash) => {
          expect(to).toBe(send.toUserId)
          expect(await world.transfers.get(send.attemptId)).toMatchObject({invoiceHash: hash})
          if (state === 'unknown') throw new Error('LNbits unavailable')
          return state
        }
        world.payImpl = async (_user, bolt11) => {
          if (world.stored.find(row => row.bolt11 === bolt11)?.kind === 'fee') {
            feeCalls += 1
            await world.pay(bolt11)
            return
          }
          primaryCalls += 1
          if (answer === 'already_paid') throw new InvoiceAlreadyPaidError()
          return {paymentHash: 'untrusted-nwc-hash'}
        }

        expect(await world.service.settle(input)).toEqual({outcome: 'in_flight'})
        expect(await world.transfers.get(send.attemptId)).toMatchObject({
          phase: 'pay_unknown',
          status: 'pending',
          providerAccepted: false,
          providerPaymentHash: null,
        })
        expect(await world.service.settle(input)).toEqual({outcome: 'in_flight'})
        expect(await world.service.reconcile(send.attemptId)).toBe('in_flight')
        expect(world.paid('user')).toHaveLength(0)
        expect(world.paid('fee')).toHaveLength(0)
        expect(world.created('fee')).toBe(0)
        expect(world.donations).toHaveLength(0)
        expect(notices).toBe(0)
        expect(feeCalls).toBe(0)

        const row = await world.transfers.get(send.attemptId)
        if (!row.bolt11) throw new Error('missing recipient invoice')
        // The recipient LNbits now sees the external payment, independently of NWC.
        await world.pay(row.bolt11)
        world.lookupRecipient = async (_to, hash) => world.lookup(hash)
        if (recovery === 'observe') {
          expect(await world.service.settle(input)).toMatchObject({outcome: 'settled'})
        } else {
          expect(await world.service.reconcile(send.attemptId)).toBe('settled')
        }
        expect(await world.service.reconcile(send.attemptId)).toBe('settled')
        expect(await world.service.settle(input)).toMatchObject({outcome: 'settled'})
        expect((await world.transfers.get(send.attemptId)).phase).toBe('settled')
        expect(primaryCalls).toBe(1)
        expect(world.created('user')).toBe(1)
        expect(world.paid('user')).toHaveLength(1)
        expect(feeCalls).toBe(1)
        expect(world.paid('fee')).toHaveLength(1)
        expect(world.donations).toHaveLength(1)
        expect(notices).toBe(1)
      })
    }
  }

  for (const state of ['pending', 'retryable', 'unknown'] as const) {
    test(`unconfirmed NWC ${answer} with ${state} lookup follows the review deadline`, async () => {
      const world = await worldFor({donationPercent: 10, payReviewMs: 1_000})
      let now = new Date()
      world.now = () => now
      let calls = 0
      let notices = 0
      world.notify = async () => {
        notices += 1
        return true
      }
      world.payImpl = async () => {
        calls += 1
        if (answer === 'already_paid') throw new InvoiceAlreadyPaidError()
        return undefined
      }
      world.lookupRecipient = async () => {
        if (state === 'unknown') throw new Error('LNbits unavailable')
        return state
      }
      expect(await world.service.settle({...send, rail: 'nwc'})).toEqual({outcome: 'in_flight'})
      now = new Date(now.getTime() + 2_000)
      const abandoned = state === 'retryable'
      expect(await world.service.reconcile(send.attemptId)).toBe(
        abandoned ? 'abandoned' : 'needs_review',
      )
      expect(await world.service.reconcile(send.attemptId)).toBe(
        abandoned ? 'abandoned' : 'in_flight',
      )
      expect(await world.transfers.get(send.attemptId)).toMatchObject({
        phase: abandoned ? 'abandoned' : 'needs_review',
        providerAccepted: false,
      })
      expect(calls).toBe(1)
      expect(notices).toBe(0)
      expect(world.paid('user')).toHaveLength(0)
      expect(world.paid('fee')).toHaveLength(0)
      expect(world.donations).toHaveLength(0)
    })
  }
}

test('internal already-paid acceptance still settles without a recipient lookup', async () => {
  const world = await worldFor({donationPercent: 0})
  let lookups = 0
  world.lookupRecipient = async () => {
    lookups += 1
    return 'pending'
  }
  world.payImpl = async () => {
    throw new InvoiceAlreadyPaidError()
  }
  expect(await world.service.settle(send)).toMatchObject({outcome: 'settled'})
  expect(lookups).toBe(0)
  expect(world.paid('fee')).toHaveLength(0)
  expect(world.donations).toHaveLength(0)
})

test('an unknown pay is in flight and is not paid again', async () => {
  const world = await worldFor({donationPercent: 0})
  world.payImpl = async () => {
    throw new NWCTimeoutError()
  }
  const first = await world.service.settle(send)
  expect(first).toEqual({outcome: 'in_flight'})
  expect(world.created('user')).toBe(1)

  world.payImpl = async (_user, bolt11) => {
    await world.pay(bolt11)
    return undefined
  }
  const second = await world.service.settle(send)
  expect(second).toEqual({outcome: 'in_flight'})
  expect(world.payCalls).toBe(0)
  expect(world.created('user')).toBe(1)
})

test('reconciliation collects the donation for a pay that landed before the timeout', async () => {
  const world = await worldFor({donationPercent: 10})
  world.payImpl = async (_user, bolt11) => {
    await world.pay(bolt11)
    const row = world.stored.find(invoice => invoice.bolt11 === bolt11)
    if (row?.kind === 'user') throw new NWCTimeoutError()
    return undefined
  }
  expect(await world.service.settle(send)).toEqual({outcome: 'in_flight'})
  expect(world.paid('fee')).toHaveLength(0)

  expect(await world.service.reconcile(send.attemptId)).toBe('settled')
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.donations).toHaveLength(1)
  expect(world.donations[0]?.amountSats).toBe(3)

  expect(await world.service.reconcile(send.attemptId)).toBe('settled')
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.payCalls).toBe(2)
})

test('a notice that did not send stays in flight so recovery can continue', async () => {
  const world = await worldFor({donationPercent: 0})
  await world.transfers.reserve({...send, id: send.attemptId, createdAt: new Date()})
  await world.transfers.markSettled(send.attemptId)
  world.notify = async () => false
  expect(await world.service.reconcile(send.attemptId)).toBe('in_flight')
  world.notify = async () => true
  expect(await world.service.reconcile(send.attemptId)).toBe('settled')
})

test('a stuck unknown pay is listed before a settled notice', async () => {
  const world = await worldFor({donationPercent: 0})
  const created = new Date('2026-01-01T00:00:00Z')
  world.now = () => created
  world.payImpl = async () => {
    throw new NWCTimeoutError()
  }
  await world.service.settle({...send, attemptId: 'stuck'})
  await world.transfers.reserve({
    id: 'notice',
    fromUserId: 1,
    toUserId: 2,
    sats: 21,
    rail: 'internal',
    createdAt: new Date(created.getTime() + 1_000),
  })
  await world.transfers.markSettled('notice')
  const [first] = await world.service.listActionable(1, 0)
  expect(first?.id).toBe('stuck')
})

test('reconciliation settles a paid unknown transfer and does not pay again', async () => {
  const world = await worldFor({donationPercent: 0})
  world.payImpl = async (_user, bolt11) => {
    await world.pay(bolt11)
    throw new NWCTimeoutError()
  }
  expect(await world.service.settle(send)).toEqual({outcome: 'in_flight'})
  expect(world.payCalls).toBe(1)

  const reconciled = await world.service.reconcile(send.attemptId)
  expect(reconciled).toBe('settled')
  expect(world.payCalls).toBe(1)
  expect(await world.service.settle(send)).toMatchObject({outcome: 'settled'})
  expect(world.payCalls).toBe(1)
})

test('an invoice that was saved and never submitted is abandoned without paying', async () => {
  const world = await worldFor({donationPercent: 0, invoiceGraceMs: 1_000})
  const created = new Date('2026-01-01T00:00:00Z')
  world.now = () => created
  world.payImpl = async () => {
    throw new Error('must not pay')
  }
  const row = await world.transfers.reserve({...send, id: send.attemptId, createdAt: created})
  await world.transfers.saveInvoice(row.id, null, {hash: 'saved', bolt11: 'saved'})
  world.now = () => new Date(created.getTime() + 60_000)
  expect(await world.service.reconcile(send.attemptId)).toBe('abandoned')
  expect(world.payCalls).toBe(0)
})

test('an unknown pay past the review window is logged and not paid again', async () => {
  const world = await worldFor({donationPercent: 0, payReviewMs: 1_000})
  const created = new Date('2026-01-01T00:00:00Z')
  world.now = () => created
  world.payImpl = async () => {
    throw new NWCTimeoutError()
  }
  expect(await world.service.settle(send)).toEqual({outcome: 'in_flight'})
  world.now = () => new Date(created.getTime() + 60_000)
  expect(await world.service.reconcile(send.attemptId)).toBe('needs_review')
  expect(world.payCalls).toBe(0)
  expect(await world.service.reconcile(send.attemptId)).toBe('in_flight')
})

test('insufficient fee is skipped and does not warn or repay the recipient', async () => {
  const world = await worldFor({donationPercent: 10})
  let feePays = 0
  world.payImpl = async (_user, bolt11) => {
    const row = world.stored.find(invoice => invoice.bolt11 === bolt11)
    if (row?.kind === 'fee') {
      feePays += 1
      throw new InsufficientFundsError()
    }
    await world.pay(bolt11)
    return undefined
  }
  const result = await world.service.settle(send)
  expect(result).toMatchObject({outcome: 'settled', fee: 'skipped'})
  expect(world.paid('user')).toHaveLength(1)
  expect(feePays).toBe(1)
  const again = await world.service.settle(send)
  expect(again).toMatchObject({outcome: 'settled', fee: 'skipped'})
  expect(feePays).toBe(1)
  expect(world.payCalls).toBe(1)
})

test('replaying a settled send collects the fee once', async () => {
  const world = await worldFor({donationPercent: 10})
  const first = await world.service.settle(send)
  const second = await world.service.settle(send)
  expect(first).toMatchObject({outcome: 'settled', fee: 'collected'})
  expect(second).toMatchObject({outcome: 'settled', fee: 'collected'})
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.donations).toHaveLength(1)
  expect(world.donations[0]?.amountSats).toBe(3)
})

test('an attempt id cannot be reused for a different amount', async () => {
  const world = await worldFor({donationPercent: 0})
  await world.service.settle(send)
  await expect(world.service.settle({...send, sats: 22})).rejects.toThrow(/does not match/)
  expect(world.paid('user')).toHaveLength(1)
})

async function worldFor(opts: {
  donationPercent: number
  noticeLeaseMs?: number
  invoiceGraceMs?: number
  payReviewMs?: number
}) {
  const db = createTestDb()
  const users = createUserRepository(db)
  const invoices: Stored[] = []
  const donations: {amountSats: number; paymentHash: string}[] = []
  let seq = 0
  let payCalls = 0
  let now = () => new Date()
  let notify: DmTransferDeps['notify'] = async () => true
  let notifySender: NonNullable<DmTransferDeps['notifySender']> = async () => true
  let lookupRecipient: DmTransferDeps['lookupRecipient'] = async (_to, hash) => lookup(hash)
  let payImpl: DmTransferDeps['pay'] = async (_user, bolt11) => {
    await pay(bolt11)
    return undefined
  }

  const create = (kind: Stored['kind']) => {
    seq += 1
    const hash = `${kind}-${seq}`
    invoices.push({hash, bolt11: hash, paid: false, kind})
    return {payment_hash: hash, bolt11: hash}
  }
  const lookup = (hash: string): PayoutState => {
    const row = invoices.find(invoice => invoice.hash === hash)
    if (!row) return 'retryable'
    return row.paid ? 'paid' : 'pending'
  }
  const pay = async (bolt11: string) => {
    const row = invoices.find(invoice => invoice.bolt11 === bolt11)
    if (!row) throw new Error(`missing ${bolt11}`)
    if (row.paid) throw new InvoiceAlreadyPaidError()
    await Bun.sleep(20)
    if (row.paid) throw new InvoiceAlreadyPaidError()
    row.paid = true
    payCalls += 1
  }

  await users.createOrUpdate({id: 1, username: 'a', donationPercent: opts.donationPercent})
  await users.createOrUpdate({id: 2, username: 'b'})
  const transfers = createDmTransferRepository(db)
  const service = createDmTransferService({
    transfers,
    log,
    now: () => now(),
    noticeLeaseMs: opts.noticeLeaseMs,
    invoiceGraceMs: opts.invoiceGraceMs,
    payReviewMs: opts.payReviewMs,
    createRecipientInvoice: async () => create('user'),
    lookupRecipient: (to, hash) => lookupRecipient(to, hash),
    createFeeInvoice: async () => create('fee'),
    lookupFee: async hash => lookup(hash),
    pay: (user, bolt11, rail) => payImpl(user, bolt11, rail),
    getUser: async () => ({donationPercent: opts.donationPercent, donationScope: 'tips'}),
    findDonation: async hash => donations.find(row => row.paymentHash === hash),
    insertDonation: async input => {
      donations.push({amountSats: input.amountSats, paymentHash: input.paymentHash})
    },
    notify: input => notify(input),
    notifySender: input => notifySender(input),
  })

  return {
    service,
    transfers,
    donations,
    stored: invoices,
    get payCalls() {
      return payCalls
    },
    paid(kind: Stored['kind']) {
      return invoices.filter(invoice => invoice.kind === kind && invoice.paid)
    },
    created(kind: Stored['kind']) {
      return invoices.filter(invoice => invoice.kind === kind).length
    },
    lookup,
    pay,
    set now(next: () => Date) {
      now = next
    },
    set notify(next: DmTransferDeps['notify']) {
      notify = next
    },
    set notifySender(next: NonNullable<DmTransferDeps['notifySender']>) {
      notifySender = next
    },
    set lookupRecipient(next: DmTransferDeps['lookupRecipient']) {
      lookupRecipient = next
    },
    set payImpl(next: DmTransferDeps['pay']) {
      payImpl = next
    },
  }
}

for (const final of ['paid', 'retryable'] as const) {
  test(`needs_review retries its notice and later tells the DM sender ${final}`, async () => {
    const world = await worldFor({donationPercent: 10, payReviewMs: 1_000})
    let now = new Date()
    world.now = () => now
    world.payImpl = async () => {
      throw new PaymentPendingError()
    }
    let delivered = false
    const notices: string[] = []
    world.notifySender = async ({outcome}) => {
      notices.push(outcome)
      return delivered
    }
    expect(await world.service.settle(send)).toEqual({outcome: 'in_flight'})
    now = new Date(now.getTime() + 2_000)
    expect(await world.service.reconcile(send.attemptId)).toBe('needs_review')
    expect((await world.service.listActionable(20, 0)).map(row => row.id)).toEqual([send.attemptId])
    delivered = true
    await world.service.reconcile(send.attemptId)
    expect((await world.transfers.get(send.attemptId)).senderNotified).toBe(false)
    expect((await world.transfers.get(send.attemptId)).reviewNotified).toBe(true)
    expect(await world.service.listActionable(20, 0)).toEqual([])
    now = new Date(now.getTime() + 60 * 60_000 + 1_000)
    expect((await world.service.listActionable(20, 0)).map(row => row.id)).toEqual([send.attemptId])
    world.lookupRecipient = async () => final
    world.payImpl = async (_user, bolt11) => {
      await world.pay(bolt11)
      return undefined
    }
    expect(await world.service.reconcile(send.attemptId)).toBe(
      final === 'paid' ? 'settled' : 'abandoned',
    )
    expect(notices).toEqual([
      'needs_review',
      'needs_review',
      final === 'paid' ? 'settled' : 'abandoned',
    ])
    expect(world.paid('fee')).toHaveLength(final === 'paid' ? 1 : 0)
    expect(world.donations).toHaveLength(final === 'paid' ? 1 : 0)
    expect(world.paid('user')).toHaveLength(0)
    expect(await world.service.listActionable(20, 0)).toEqual([])
  })
}

for (const phase of ['reserved', 'invoice_saved', 'pay_unknown'] as const) {
  test(`an undelivered abandoned DM ${phase} notice is retried until delivered`, async () => {
    const world = await worldFor({donationPercent: 0, invoiceGraceMs: 1_000, payReviewMs: 1_000})
    let now = new Date()
    world.now = () => now
    let tries = 0
    world.notifySender = async () => {
      tries += 1
      if (tries === 1) throw new Error('Telegram unavailable')
      return true
    }
    await world.transfers.reserve({...send, id: send.attemptId, createdAt: now})
    if (phase !== 'reserved')
      await world.transfers.saveInvoice(send.attemptId, null, {hash: 'abandon', bolt11: 'bolt'})
    if (phase === 'pay_unknown')
      await world.transfers.markPhase(send.attemptId, 'pay_unknown', 'invoice_saved')
    world.lookupRecipient = async () => 'retryable'
    now = new Date(now.getTime() + 2_000)
    expect(await world.service.reconcile(send.attemptId)).toBe('abandoned')
    expect((await world.service.listActionable(20, 0)).map(row => row.id)).toEqual([send.attemptId])
    await world.service.reconcile(send.attemptId)
    expect(tries).toBe(2)
    expect(await world.service.listActionable(20, 0)).toEqual([])
    expect(world.paid('user')).toHaveLength(0)
    expect(world.paid('fee')).toHaveLength(0)
  })
}

test('the wizard claims its sender receipt at settle and releases a failed screen', async () => {
  const world = await worldFor({donationPercent: 0})
  let notices = 0
  world.notifySender = async () => {
    notices += 1
    return true
  }
  await world.service.settle(send)
  expect((await world.transfers.get(send.attemptId)).senderNotified).toBe(true)
  await world.service.reconcile(send.attemptId)
  expect(notices).toBe(0)
  await world.service.releaseSenderNotice(send.attemptId)
  await world.service.reconcile(send.attemptId)
  expect(notices).toBe(1)
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(0)
})

test('a wizard losing settle to recovery reads the collected fee without warning or repaying', async () => {
  const world = await worldFor({donationPercent: 10})
  let recovered = false
  world.lookupRecipient = async (_to, hash) => {
    if (!recovered) {
      recovered = true
      await world.service.reconcile(send.attemptId)
    }
    return world.lookup(hash)
  }
  expect(await world.service.settle(send)).toEqual({
    outcome: 'settled',
    fee: 'collected',
    notice: 'sent',
  })
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.donations).toHaveLength(1)
})

test('a pending DM fee is not recorded, paid again, or mistaken for a failed primary', async () => {
  const world = await worldFor({donationPercent: 10})
  let feeCalls = 0
  world.payImpl = async (_user, bolt11) => {
    if (world.stored.find(row => row.bolt11 === bolt11)?.kind === 'fee') {
      feeCalls += 1
      throw new PaymentPendingError()
    }
    await world.pay(bolt11)
    return undefined
  }
  expect(await world.service.settle(send)).toMatchObject({outcome: 'settled', fee: 'failed'})
  await world.service.reconcile(send.attemptId)
  expect(world.donations).toHaveLength(0)
  expect(feeCalls).toBe(1)
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(0)
})

test('losing the fee invoice claim observes recovery payment without a false warning', async () => {
  const world = await worldFor({donationPercent: 10})
  const save = world.transfers.saveFeeInvoice.bind(world.transfers)
  let raced = false
  world.transfers.saveFeeInvoice = async (id, invoice) => {
    if (!raced) {
      raced = true
      await world.service.reconcile(send.attemptId)
    }
    return save(id, invoice)
  }
  expect(await world.service.settle(send)).toEqual({
    outcome: 'settled',
    fee: 'collected',
    notice: 'sent',
  })
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.donations).toHaveLength(1)
})

test('the unique open-send index blocks a simultaneous new attempt before its debit', async () => {
  const world = await worldFor({donationPercent: 0})
  let now = new Date()
  world.now = () => now
  const notices: string[] = []
  world.notifySender = async ({outcome}) => {
    notices.push(outcome)
    return true
  }
  const ids = [send.attemptId, 'concurrent-new-attempt']
  const results = await Promise.all(
    ids.map(attemptId => world.service.settle({...send, attemptId})),
  )
  expect(results.some(result => result.outcome === 'blocked')).toBe(true)
  expect(results.some(result => result.outcome === 'settled')).toBe(true)
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(0)
  expect(world.payCalls).toBe(1)
  const blockedId = ids[results.findIndex(result => result.outcome === 'blocked')]
  if (!blockedId) throw new Error('missing blocked transfer')
  const blocked = await world.transfers.get(blockedId)
  expect(blocked.phase).toBe('abandoned')
  expect(blocked.senderNotified).toBe(true)
  now = new Date(now.getTime() + 3 * 60_000)
  await world.service.reconcile(blockedId)
  expect(notices).toEqual([])
  expect(await world.service.listActionable(20, 0)).toEqual([])
  expect(await world.transfers.findOpen(send.fromUserId, send.toUserId)).toBeUndefined()
})

test('a wizard insufficient-funds refusal is not announced again by DM recovery', async () => {
  const world = await worldFor({donationPercent: 10})
  let notices = 0
  world.notifySender = async () => {
    notices += 1
    return true
  }
  world.payImpl = async () => {
    throw new InsufficientFundsError()
  }
  expect(await world.service.settle(send)).toEqual({
    outcome: 'rejected',
    reason: 'insufficient_funds',
  })
  expect((await world.transfers.get(send.attemptId)).senderNotified).toBe(true)
  await world.service.reconcile(send.attemptId)
  await world.service.reconcile(send.attemptId)
  expect(notices).toBe(0)
  expect(await world.service.listActionable(20, 0)).toEqual([])
  expect(await world.transfers.findOpen(send.fromUserId, send.toUserId)).toBeUndefined()
  expect(world.paid('user')).toHaveLength(0)
  expect(world.paid('fee')).toHaveLength(0)
})
