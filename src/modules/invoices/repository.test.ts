import {describe, expect, test} from 'bun:test'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createInvoiceRepository} from './repository.js'

describe('invoice repository', () => {
  test('deleteExpired returns the deleted pending invoice rows', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const invoices = createInvoiceRepository(db)
    await users.createOrUpdate({id: 1, languageCode: 'en'})

    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60_000 * 60)

    await invoices.create({
      paymentRequest: 'lnbc-expired',
      paymentHash: 'h-expired',
      userId: 1,
      expiresAt: past,
    })
    await invoices.create({
      paymentRequest: 'lnbc-live',
      paymentHash: 'h-live',
      userId: 1,
      expiresAt: future,
    })

    const deleted = await invoices.deleteExpired()
    expect(deleted).toEqual([
      expect.objectContaining({
        paymentRequest: 'lnbc-expired',
        paymentHash: 'h-expired',
        userId: 1,
      }),
    ])
    expect(await invoices.count()).toBe(1)
    expect(await invoices.findByPaymentRequest('lnbc-live')).toBeDefined()
    expect(await invoices.findByPaymentRequest('lnbc-expired')).toBeUndefined()
  })

  test('claimByPaymentHash returns the row once and null on a second claim', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const invoices = createInvoiceRepository(db)
    await users.createOrUpdate({id: 1, languageCode: 'en'})

    await invoices.create({
      paymentRequest: 'lnbc-claim',
      paymentHash: 'h-claim',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const first = await invoices.claimByPaymentHash('h-claim')
    expect(first).toMatchObject({paymentRequest: 'lnbc-claim', paymentHash: 'h-claim', userId: 1})
    expect(await invoices.claimByPaymentHash('h-claim')).toBeUndefined()
    expect(await invoices.claimByPaymentRequest('lnbc-claim')).toBeUndefined()
    expect(await invoices.count()).toBe(0)
  })

  test('moveWidgetMessage rolls back the source when the destination row is gone', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const invoices = createInvoiceRepository(db)
    await users.createOrUpdate({id: 1, languageCode: 'en'})
    await invoices.create({
      paymentRequest: 'lnbc-a',
      paymentHash: 'h-a',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
      widgetChatId: 7,
      widgetMessageId: 11,
    })
    await invoices.create({
      paymentRequest: 'lnbc-b',
      paymentHash: 'h-b',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await invoices.deleteByPaymentRequest('lnbc-b')

    await expect(invoices.moveWidgetMessage('lnbc-a', 'lnbc-b', 7, 11)).rejects.toThrow(
      'Invoice widget destination is gone',
    )
    expect(await invoices.findByPaymentRequest('lnbc-a')).toMatchObject({
      widgetChatId: 7,
      widgetMessageId: 11,
    })
  })

  test('moveWidgetMessage leaves the destination alone when the source was already claimed', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const invoices = createInvoiceRepository(db)
    await users.createOrUpdate({id: 1, languageCode: 'en'})
    await invoices.create({
      paymentRequest: 'lnbc-a',
      paymentHash: 'h-a',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
      widgetChatId: 7,
      widgetMessageId: 11,
    })
    await invoices.create({
      paymentRequest: 'lnbc-b',
      paymentHash: 'h-b',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
    })
    await invoices.claimByPaymentRequest('lnbc-a')

    expect(await invoices.moveWidgetMessage('lnbc-a', 'lnbc-b', 7, 11)).toBe(false)
    expect(await invoices.findByPaymentRequest('lnbc-b')).toMatchObject({
      widgetChatId: null,
      widgetMessageId: null,
    })
  })

  test('moveWidgetMessage points the live message at the new invoice and clears the old one', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const invoices = createInvoiceRepository(db)
    await users.createOrUpdate({id: 1, languageCode: 'en'})
    await invoices.create({
      paymentRequest: 'lnbc-a',
      paymentHash: 'h-a',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
      widgetChatId: 7,
      widgetMessageId: 11,
    })
    await invoices.create({
      paymentRequest: 'lnbc-b',
      paymentHash: 'h-b',
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await invoices.moveWidgetMessage('lnbc-a', 'lnbc-b', 7, 11)).toBe(true)
    expect(await invoices.findByPaymentRequest('lnbc-a')).toMatchObject({
      widgetChatId: null,
      widgetMessageId: null,
    })
    expect(await invoices.findByPaymentRequest('lnbc-b')).toMatchObject({
      widgetChatId: 7,
      widgetMessageId: 11,
    })
  })
})
