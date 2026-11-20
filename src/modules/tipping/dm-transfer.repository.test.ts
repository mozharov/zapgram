import {expect, test} from 'bun:test'
import {createDmTransferRepository} from '@modules/tipping/dm-transfer.repository.js'
import {createUserRepository} from '@modules/users/repository.js'
import {createTestDb} from '@test/helpers/db.js'

test('abandonIfPhase and saveInvoice only move a row from the phase they name', async () => {
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
  await transfers.abandonIfPhase(accepted.id, 'pay_unknown')
  expect((await transfers.get(accepted.id)).phase).toBe('provider_accepted')

  const abandoned = await transfers.reserve({
    id: 'abandoned',
    fromUserId: 1,
    toUserId: 2,
    sats: 10,
    rail: 'internal',
  })
  await transfers.abandonIfPhase(abandoned.id, 'reserved')
  const revived = await transfers.saveInvoice(abandoned.id, null, {hash: 'other', bolt11: 'other'})
  expect(revived).toBeUndefined()
  expect((await transfers.get(abandoned.id)).phase).toBe('abandoned')
  expect((await transfers.get(abandoned.id)).invoiceHash).toBeNull()
  expect(await transfers.markSettled(abandoned.id)).toBe(false)
  expect((await transfers.get(abandoned.id)).phase).toBe('abandoned')
})

test('markNeedsReview cannot move a reserved, accepted or settled DM transfer', async () => {
  const db = createTestDb()
  const users = createUserRepository(db)
  await users.getOrCreate({id: 1, languageCode: 'en'})
  await users.getOrCreate({id: 2, languageCode: 'en'})
  const transfers = createDmTransferRepository(db)
  await transfers.reserve({id: 'guard', fromUserId: 1, toUserId: 2, sats: 10, rail: 'internal'})
  expect(await transfers.markNeedsReview('guard')).toBe(false)
  await transfers.saveInvoice('guard', null, {hash: 'hash', bolt11: 'bolt'})
  await transfers.markPhase('guard', 'pay_unknown', 'invoice_saved')
  await transfers.markProviderAccepted('guard', 'hash')
  expect(await transfers.markNeedsReview('guard')).toBe(false)
  await transfers.markSettled('guard')
  expect(await transfers.markNeedsReview('guard')).toBe(false)
  expect((await transfers.get('guard')).phase).toBe('settled')
})
