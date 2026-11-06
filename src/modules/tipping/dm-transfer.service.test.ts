import {expect, test} from 'bun:test'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import type {PayoutState} from '@core/payments/payout-state.js'
import type {AppLogger} from '@infra/logger.js'
import {createDmTransferRepository} from '@modules/tipping/dm-transfer.repository.js'
import {createDmTransferService} from '@modules/tipping/dm-transfer.service.js'
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

test('two workers settling one attempt pay the recipient once', async () => {
  const world = await worldFor({donationPercent: 0})
  const input = {
    attemptId: '1:100',
    fromUserId: 1,
    toUserId: 2,
    sats: 21,
    payInvoice: world.pay,
    notify: async () => true,
  }
  const [first, second] = await Promise.all([
    world.service.settle(input),
    world.service.settle(input),
  ])
  expect(world.paid('user')).toHaveLength(1)
  expect(first.outcome === 'settled' || second.outcome === 'settled').toBe(true)
  expect(
    [first.outcome, second.outcome].every(
      outcome => outcome === 'settled' || outcome === 'in_flight',
    ),
  ).toBe(true)

  const again = await world.service.settle(input)
  expect(again).toMatchObject({outcome: 'settled', fee: 'skipped', notice: 'sent'})
  expect(world.paid('user')).toHaveLength(1)
  expect(world.payCalls).toBe(1)
})

test('a failed notice does not pay the recipient again', async () => {
  const world = await worldFor({donationPercent: 0})
  const base = {
    attemptId: '1:200',
    fromUserId: 1,
    toUserId: 2,
    sats: 21,
    payInvoice: world.pay,
  }
  const failed = await world.service.settle({...base, notify: async () => false})
  expect(failed).toMatchObject({outcome: 'settled', notice: 'failed'})
  expect(world.payCalls).toBe(1)

  const retried = await world.service.settle({...base, notify: async () => true})
  expect(retried).toMatchObject({outcome: 'settled', notice: 'sent'})
  expect(world.payCalls).toBe(1)
})

test('replaying a settled send collects the fee once', async () => {
  const world = await worldFor({donationPercent: 10})
  const input = {
    attemptId: '1:300',
    fromUserId: 1,
    toUserId: 2,
    sats: 21,
    payInvoice: world.pay,
    notify: async () => true,
  }
  const first = await world.service.settle(input)
  const second = await world.service.settle(input)
  expect(first).toMatchObject({outcome: 'settled', fee: 'collected'})
  expect(second).toMatchObject({outcome: 'settled', fee: 'collected'})
  expect(world.paid('user')).toHaveLength(1)
  expect(world.paid('fee')).toHaveLength(1)
  expect(world.donations).toHaveLength(1)
  expect(world.donations[0]?.amountSats).toBe(3)
})

test('an attempt id cannot be reused for a different amount', async () => {
  const world = await worldFor({donationPercent: 0})
  await world.service.settle({
    attemptId: '1:400',
    fromUserId: 1,
    toUserId: 2,
    sats: 21,
    payInvoice: world.pay,
    notify: async () => true,
  })
  await expect(
    world.service.settle({
      attemptId: '1:400',
      fromUserId: 1,
      toUserId: 2,
      sats: 22,
      payInvoice: world.pay,
      notify: async () => true,
    }),
  ).rejects.toThrow(/does not match/)
  expect(world.paid('user')).toHaveLength(1)
})

async function worldFor(user: {donationPercent: number}) {
  const db = createTestDb()
  const users = createUserRepository(db)
  const invoices: Stored[] = []
  const donations: {amountSats: number; paymentHash: string}[] = []
  let seq = 0
  let payCalls = 0

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

  await users.createOrUpdate({id: 1, username: 'a', donationPercent: user.donationPercent})
  await users.createOrUpdate({id: 2, username: 'b'})

  const service = createDmTransferService({
    transfers: createDmTransferRepository(db),
    log,
    createRecipientInvoice: async () => create('user'),
    lookupRecipient: async (_to, hash) => lookup(hash),
    createFeeInvoice: async () => create('fee'),
    lookupFee: async hash => lookup(hash),
    getUser: async () => ({donationPercent: user.donationPercent, donationScope: 'tips'}),
    findDonation: async hash => donations.find(row => row.paymentHash === hash),
    insertDonation: async input => {
      donations.push({amountSats: input.amountSats, paymentHash: input.paymentHash})
    },
  })

  return {
    service,
    donations,
    get payCalls() {
      return payCalls
    },
    paid(kind: Stored['kind']) {
      return invoices.filter(invoice => invoice.kind === kind && invoice.paid)
    },
    async pay(bolt11: string) {
      const row = invoices.find(invoice => invoice.bolt11 === bolt11)
      if (!row) throw new Error(`missing ${bolt11}`)
      if (row.paid) throw new InvoiceAlreadyPaidError()
      await Bun.sleep(20)
      if (row.paid) throw new InvoiceAlreadyPaidError()
      row.paid = true
      payCalls += 1
    },
  }
}
