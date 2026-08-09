import {describe, expect, test} from 'bun:test'
import {createChatRepository} from '@modules/chats/repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'
import {createOnchainPaymentRepository} from './repository.js'

describe('onchain payment repository', () => {
  test('create, find by charge, mark paid idempotently', async () => {
    const db = createTestDb()
    const users = createUserRepository(db)
    const chats = createChatRepository(db)
    const onchain = createOnchainPaymentRepository(db)

    await users.createOrUpdate({id: 1, languageCode: 'en', firstName: 'Owner'})
    await users.createOrUpdate({id: 2, languageCode: 'en', firstName: 'Sub'})
    await chats.createOrUpdate({
      id: -100,
      title: 'Paid',
      type: 'supergroup',
      ownerId: 1,
      status: 'active',
      price: 1000,
      paymentType: 'one_time',
      onchainEnabled: true,
      watchonlyWalletId: 'wo-1',
    })

    const expiresAt = new Date('2026-08-09T12:00:00.000Z')
    const watchUntil = new Date('2026-08-10T12:00:00.000Z')
    const row = await onchain.create({
      chatId: -100,
      userId: 2,
      satspayChargeId: 'ch-1',
      address: 'bc1qtest',
      amountSats: 1000,
      expiresAt,
      watchUntil,
    })

    expect(row.status).toBe('pending')
    expect((await onchain.findByChargeId('ch-1'))?.id).toBe(row.id)

    const paid = await onchain.markPaid(row.id, {txid: 'tx1'})
    expect(paid?.status).toBe('paid')
    expect(paid?.txid).toBe('tx1')

    const again = await onchain.markPaid(row.id, {txid: 'tx2'})
    expect(again).toBeNull()
    expect((await onchain.findById(row.id))?.txid).toBe('tx1')
  })
})
