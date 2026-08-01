import {describe, expect, test} from 'bun:test'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createInvoiceRepository} from './repository.js'

describe('invoice repository', () => {
  test('deleteExpired returns the number of deleted rows', async () => {
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
    expect(deleted).toBe(1)
    expect(await invoices.count()).toBe(1)
    expect(await invoices.findByPaymentRequest('lnbc-live')).toBeDefined()
    expect(await invoices.findByPaymentRequest('lnbc-expired')).toBeUndefined()
  })
})
