import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {computeDonationSats, type DonationScope, shouldApplyDonation} from '@core/money/donation.js'
import type {PayoutState} from '@core/payments/payout-state.js'
import type {DmTransfer} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {DmTransferRepository} from './dm-transfer.repository.js'

export type DmTransferSettlement =
  | {outcome: 'settled'; fee: 'collected' | 'skipped' | 'failed'; notice: 'sent' | 'failed'}
  | {outcome: 'in_flight'}

type Invoice = {payment_hash: string; bolt11: string}

export type DmTransferDeps = {
  transfers: DmTransferRepository
  log: AppLogger
  createRecipientInvoice: (toUserId: number, sats: number) => Promise<Invoice>
  lookupRecipient: (toUserId: number, hash: string) => Promise<PayoutState>
  createFeeInvoice: (sats: number) => Promise<Invoice>
  lookupFee: (hash: string) => Promise<PayoutState>
  getUser: (userId: number) => Promise<{
    donationPercent: number
    donationScope: DonationScope
  }>
  findDonation: (paymentHash: string) => Promise<unknown>
  insertDonation: (input: {
    userId: number
    amountSats: number
    paymentHash: string
  }) => Promise<unknown>
}

/**
 * One confirmation, one debit.
 *
 * The pending row is inserted before any invoice is paid. The invoice hash is written
 * before that invoice is paid. A second caller, including another process that still
 * has this conversation, sees the row and does not mint a second debit. Status is only
 * `pending` or `settled`: we mark settled only after the wallet accepts the pay or a
 * lookup shows that stored invoice already paid. Fee and the recipient notice run after
 * that and cannot put the row back, so a failure there does not replay the debit.
 *
 * A stored hash whose lookup is still in flight is not paid again. That is the same
 * rule as a subscription payout: an in-flight payment and an unpaid invoice look alike,
 * and paying either twice is the failure this row exists to prevent.
 */
export function createDmTransferService(deps: DmTransferDeps) {
  async function settle(input: {
    attemptId: string
    fromUserId: number
    toUserId: number
    sats: number
    payInvoice: (bolt11: string) => Promise<void>
    notify: () => Promise<boolean>
  }): Promise<DmTransferSettlement> {
    const row = await deps.transfers.reserve({
      id: input.attemptId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      sats: input.sats,
    })
    if (
      row.fromUserId !== input.fromUserId ||
      row.toUserId !== input.toUserId ||
      row.sats !== input.sats
    ) {
      throw new Error('DM transfer attempt does not match the reserved send')
    }

    if (row.status !== 'settled') {
      const primary = await settlePrimary(row, input)
      if (primary === 'in_flight') {
        deps.log.info(
          {fromUserId: input.fromUserId, toUserId: input.toUserId, sats: input.sats},
          'DM transfer already in flight',
        )
        return {outcome: 'in_flight'}
      }
    }

    const fee = await settleFee(input).catch(error => {
      deps.log.error({error, fromUserId: input.fromUserId}, 'DM transfer fee failed')
      return 'failed' as const
    })
    const notice = await settleNotice(input).catch(error => {
      deps.log.error({error, toUserId: input.toUserId}, 'DM transfer notice failed')
      return 'failed' as const
    })
    deps.log.info(
      {fromUserId: input.fromUserId, toUserId: input.toUserId, sats: input.sats, fee, notice},
      'DM transfer settled',
    )
    return {outcome: 'settled', fee, notice}
  }

  async function settlePrimary(
    row: DmTransfer,
    input: {toUserId: number; sats: number; payInvoice: (bolt11: string) => Promise<void>},
  ): Promise<'paid' | 'in_flight'> {
    if (!row.invoiceHash || !row.bolt11) {
      const invoice = await deps.createRecipientInvoice(input.toUserId, input.sats)
      const saved = await deps.transfers.saveInvoice(row.id, null, {
        hash: invoice.payment_hash,
        bolt11: invoice.bolt11,
      })
      if (!saved?.bolt11 || !saved.invoiceHash) return followStored(input.toUserId, row.id)
      await payStored(input.toUserId, saved.invoiceHash, saved.bolt11, input.payInvoice)
      await deps.transfers.markSettled(row.id)
      return 'paid'
    }

    const state = await deps.lookupRecipient(input.toUserId, row.invoiceHash)
    if (state === 'paid') {
      await deps.transfers.markSettled(row.id)
      return 'paid'
    }
    if (state === 'pending') return 'in_flight'

    const invoice = await deps.createRecipientInvoice(input.toUserId, input.sats)
    const saved = await deps.transfers.saveInvoice(row.id, row.invoiceHash, {
      hash: invoice.payment_hash,
      bolt11: invoice.bolt11,
    })
    if (!saved?.bolt11 || !saved.invoiceHash) return followStored(input.toUserId, row.id)
    await payStored(input.toUserId, saved.invoiceHash, saved.bolt11, input.payInvoice)
    await deps.transfers.markSettled(row.id)
    return 'paid'
  }

  async function followStored(toUserId: number, id: string): Promise<'paid' | 'in_flight'> {
    const latest = await deps.transfers.get(id)
    if (latest.status === 'settled') return 'paid'
    if (!latest.invoiceHash) return 'in_flight'
    const state = await deps.lookupRecipient(toUserId, latest.invoiceHash)
    if (state !== 'paid') return 'in_flight'
    await deps.transfers.markSettled(id)
    return 'paid'
  }

  async function payStored(
    toUserId: number,
    hash: string,
    bolt11: string,
    payInvoice: (bolt11: string) => Promise<void>,
  ) {
    try {
      await payInvoice(bolt11)
    } catch (error) {
      if (!(error instanceof InvoiceAlreadyPaidError)) throw error
    }
    const state = await deps.lookupRecipient(toUserId, hash)
    if (state !== 'paid') throw new Error('DM transfer invoice was not paid')
  }

  async function settleFee(input: {
    attemptId: string
    fromUserId: number
    payInvoice: (bolt11: string) => Promise<void>
  }): Promise<'collected' | 'skipped' | 'failed'> {
    const row = await deps.transfers.get(input.attemptId)
    const user = await deps.getUser(input.fromUserId)
    if (!shouldApplyDonation(user.donationScope, 'tip')) return 'skipped'
    const amountSats = computeDonationSats(row.sats, user.donationPercent)
    if (amountSats <= 0) return 'skipped'

    if (row.feeHash) {
      const state = await deps.lookupFee(row.feeHash)
      if (state === 'paid') {
        await recordFee(input.fromUserId, row.feeHash, amountSats)
        return 'collected'
      }
      // In flight or already recorded. A second fee invoice would double the optional debit.
      return 'failed'
    }

    const invoice = await deps.createFeeInvoice(amountSats)
    const saved = await deps.transfers.saveFeeInvoice(input.attemptId, {
      hash: invoice.payment_hash,
      bolt11: invoice.bolt11,
    })
    const bolt11 = saved?.feeBolt11
    const hash = saved?.feeHash
    if (!bolt11 || !hash) {
      const latest = await deps.transfers.get(input.attemptId)
      if (!latest.feeHash) return 'failed'
      const state = await deps.lookupFee(latest.feeHash)
      if (state !== 'paid') return 'failed'
      await recordFee(input.fromUserId, latest.feeHash, amountSats)
      return 'collected'
    }

    try {
      await input.payInvoice(bolt11)
    } catch (error) {
      if (!(error instanceof InvoiceAlreadyPaidError)) throw error
    }
    const state = await deps.lookupFee(hash)
    if (state !== 'paid') return 'failed'
    await recordFee(input.fromUserId, hash, amountSats)
    return 'collected'
  }

  async function recordFee(userId: number, paymentHash: string, amountSats: number) {
    if (amountSats <= 0) return
    if (await deps.findDonation(paymentHash)) return
    await deps.insertDonation({userId, amountSats, paymentHash})
  }

  async function settleNotice(input: {
    attemptId: string
    notify: () => Promise<boolean>
  }): Promise<'sent' | 'failed'> {
    const row = await deps.transfers.get(input.attemptId)
    if (row.noticeSent) return 'sent'
    const sent = await input.notify()
    if (!sent) return 'failed'
    await deps.transfers.markNoticeSent(input.attemptId)
    return 'sent'
  }

  return {settle}
}

export type DmTransferService = ReturnType<typeof createDmTransferService>
