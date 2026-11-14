import {expect, test} from 'bun:test'
import {createDmTransferRepository} from '@modules/tipping/dm-transfer.repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

test('markAbandoned and saveInvoice only move a row from the phase they name', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.getOrCreate({id: 2, languageCode: 'en'})
  const transfers = createDmTransferRepository(db)

  const accepted = await transfers.reserve({
    id: 'accepted',
    fromUserId: 1,
    toUserId: 2,
    sats: 10,
    rail: 'internal',
  })
  await transfers.saveInvoice(accepted.id, null, {hash: 'hash', bolt11: 'bolt'})
  await transfers.markPhase(accepted.id, 'pay_unknown', 'invoice_saved')
  await transfers.markProviderAccepted(accepted.id, 'hash')
  await transfers.markAbandoned(accepted.id)
  expect((await transfers.get(accepted.id)).phase).toBe('provider_accepted')

  const abandoned = await transfers.reserve({
    id: 'abandoned',
    fromUserId: 1,
    toUserId: 2,
    sats: 10,
    rail: 'internal',
  })
  await transfers.markAbandoned(abandoned.id)
  const revived = await transfers.saveInvoice(abandoned.id, null, {hash: 'other', bolt11: 'other'})
  expect(revived).toBeUndefined()
  expect((await transfers.get(abandoned.id)).phase).toBe('abandoned')
  expect((await transfers.get(abandoned.id)).invoiceHash).toBeNull()
})
