import {expect, test} from 'bun:test'
import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
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

test('a settled notice is listed before a stuck unknown pay', async () => {
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
  expect(first?.id).toBe('notice')
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
    set lookupRecipient(next: DmTransferDeps['lookupRecipient']) {
      lookupRecipient = next
    },
    set payImpl(next: DmTransferDeps['pay']) {
      payImpl = next
    },
  }
}
