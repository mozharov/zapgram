import {describe, expect, mock, test} from 'bun:test'
import type {Chat, Subscription, SubscriptionPayment} from '@infra/db/types.js'
import {createRenewalService, type RenewalServiceDeps} from './renewal.service.js'

function silentLog() {
  return {info: mock(() => {}), error: mock(() => {}), warn: mock(() => {}), debug: mock(() => {})}
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    userId: 10,
    chatId: -100,
    price: 1000,
    endsAt: new Date('2026-08-11T12:00:00.000Z'),
    autoRenew: true,
    notificationSent: false,
    createdAt: new Date('2026-07-11T12:00:00.000Z'),
    updatedAt: new Date('2026-07-11T12:00:00.000Z'),
    ...overrides,
  } as Subscription
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: -100,
    title: 'Paid room',
    type: 'supergroup',
    ownerId: 1,
    status: 'active',
    price: 1000,
    paymentType: 'monthly',
    ...overrides,
  } as Chat
}

function paymentRow(overrides: Partial<SubscriptionPayment> = {}): SubscriptionPayment {
  return {
    id: 'pay-1',
    chatId: -100,
    userId: 10,
    paymentHash: 'hash-1',
    paymentRequest: 'lnbc1000',
    subscriptionType: 'monthly',
    price: 1000,
    kind: 'renewal',
    ...overrides,
  } as SubscriptionPayment
}

function makeDeps(overrides: Partial<RenewalServiceDeps> = {}) {
  const payBalance = mock(async () => ({payment_hash: 'internal'}))
  const payNwc = mock(async () => undefined)
  const completePayment = mock(async () => 'settled' as const)
  const createSubscriptionPayment = mock(async (data: {
    chatId: number
    userId: number
    paymentHash: string
    paymentRequest: string
    subscriptionType: 'monthly'
    price: number
    kind: 'renewal'
  }) =>
    paymentRow({
      paymentHash: data.paymentHash,
      paymentRequest: data.paymentRequest,
      price: data.price,
    }),
  )
  const lookupPayment = mock(async () => ({paid: false}))
  const getUserNwcUrl = mock(async () => 'nostr+walletconnect://test')
  const createNwc = mock(() => ({payInvoice: payNwc}))

  const deps: RenewalServiceDeps = {
    getPendingPaymentForSubscription: mock(async () => null),
    createSubscriptionPayment,
    masterWallet: {
      createInvoice: mock(async (sats: number) => ({
        payment_hash: `hash-${sats}`,
        bolt11: `lnbc${sats}`,
      })),
      lookupPayment,
    },
    getUserWallet: mock(async () => ({payInvoice: payBalance})),
    getUserNwcUrl,
    createNwc,
    completePayment,
    notifier: {send: mock(async () => true), sendPhoto: mock(async () => true)} as never,
    log: silentLog() as never,
    translate: (key: string) => key,
    getBtcUsd: async () => null,
    invoiceExpirySeconds: 3600,
    ...overrides,
  }

  return {
    service: createRenewalService(deps),
    payBalance,
    payNwc,
    completePayment,
    createSubscriptionPayment,
    lookupPayment,
    getUserNwcUrl,
    createNwc,
    deps,
  }
}

describe('attemptAutoRenewal', () => {
  test('charges internal balance and does not touch NWC', async () => {
    const {service, payBalance, payNwc, completePayment, getUserNwcUrl} = makeDeps()
    const result = await service.attemptAutoRenewal(subscription(), chat())
    expect(result).toEqual({status: 'renewed'})
    expect(payBalance).toHaveBeenCalledWith('lnbc1000')
    expect(getUserNwcUrl).not.toHaveBeenCalled()
    expect(payNwc).not.toHaveBeenCalled()
    expect(completePayment).toHaveBeenCalled()
  })

  test('falls back to NWC when internal balance payment fails', async () => {
    const payBalance = mock(async () => {
      throw new Error('insufficient funds')
    })
    const {service, payNwc, completePayment, lookupPayment, getUserNwcUrl} = makeDeps({
      getUserWallet: mock(async () => ({payInvoice: payBalance})),
    })
    const result = await service.attemptAutoRenewal(subscription(), chat())
    expect(result).toEqual({status: 'renewed'})
    expect(lookupPayment).toHaveBeenCalledWith('hash-1000')
    expect(getUserNwcUrl).toHaveBeenCalledWith(10)
    expect(payNwc).toHaveBeenCalledWith('lnbc1000')
    expect(completePayment).toHaveBeenCalled()
  })

  test('does not call NWC when balance failed but master invoice is already paid', async () => {
    const payBalance = mock(async () => {
      throw new Error('timeout')
    })
    const payNwc = mock(async () => undefined)
    const {service, completePayment, getUserNwcUrl} = makeDeps({
      getUserWallet: mock(async () => ({payInvoice: payBalance})),
      masterWallet: {
        createInvoice: mock(async () => ({payment_hash: 'hash-paid', bolt11: 'lnbc1000'})),
        lookupPayment: mock(async () => ({paid: true})),
      },
      createNwc: mock(() => ({payInvoice: payNwc})),
    })
    const result = await service.attemptAutoRenewal(subscription(), chat())
    expect(result).toEqual({status: 'renewed'})
    expect(getUserNwcUrl).not.toHaveBeenCalled()
    expect(payNwc).not.toHaveBeenCalled()
    expect(completePayment).toHaveBeenCalled()
  })

  test('fails without settle when neither balance nor NWC can pay', async () => {
    const payBalance = mock(async () => {
      throw new Error('insufficient funds')
    })
    const payNwc = mock(async () => {
      throw new Error('nwc failed')
    })
    const {service, completePayment} = makeDeps({
      getUserWallet: mock(async () => ({payInvoice: payBalance})),
      createNwc: mock(() => ({payInvoice: payNwc})),
    })
    const result = await service.attemptAutoRenewal(subscription(), chat())
    expect(result).toEqual({status: 'failed'})
    expect(payNwc).toHaveBeenCalled()
    expect(completePayment).not.toHaveBeenCalled()
  })

  test('fails without NWC attempt when user has no nwc_url', async () => {
    const payBalance = mock(async () => {
      throw new Error('insufficient funds')
    })
    const payNwc = mock(async () => undefined)
    const createNwc = mock(() => ({payInvoice: payNwc}))
    const {service, completePayment} = makeDeps({
      getUserWallet: mock(async () => ({payInvoice: payBalance})),
      getUserNwcUrl: mock(async () => null),
      createNwc,
    })
    const result = await service.attemptAutoRenewal(subscription(), chat())
    expect(result).toEqual({status: 'failed'})
    expect(createNwc).not.toHaveBeenCalled()
    expect(payNwc).not.toHaveBeenCalled()
    expect(completePayment).not.toHaveBeenCalled()
  })

  test('settles when NWC throws but the master invoice is paid', async () => {
    const payBalance = mock(async () => {
      throw new Error('insufficient funds')
    })
    const payNwc = mock(async () => {
      throw new Error('already been paid')
    })
    let lookups = 0
    const lookupPayment = mock(async () => {
      lookups++
      // First check after balance: unpaid. Second after NWC: paid.
      return {paid: lookups >= 2}
    })
    const {service, completePayment} = makeDeps({
      getUserWallet: mock(async () => ({payInvoice: payBalance})),
      createNwc: mock(() => ({payInvoice: payNwc})),
      masterWallet: {
        createInvoice: mock(async () => ({payment_hash: 'hash-1', bolt11: 'lnbc1000'})),
        lookupPayment,
      },
    })
    const result = await service.attemptAutoRenewal(subscription(), chat())
    expect(result).toEqual({status: 'renewed'})
    expect(payNwc).toHaveBeenCalled()
    expect(completePayment).toHaveBeenCalled()
  })

  test('skips charge when autoRenew is off', async () => {
    const {service, payBalance, payNwc, completePayment} = makeDeps()
    const result = await service.attemptAutoRenewal(subscription({autoRenew: false}), chat())
    expect(result).toEqual({status: 'failed'})
    expect(payBalance).not.toHaveBeenCalled()
    expect(payNwc).not.toHaveBeenCalled()
    expect(completePayment).not.toHaveBeenCalled()
  })
})
