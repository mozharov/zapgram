import {editOnchainStatusMessage} from '@modules/onchain/telegram/edit-status-message.js'
import {getRuntime} from '../../../runtime.js'
import {extractTxidFromChargeExtra} from '../txid.js'

/**
 * Safety net when SatsPay webhook is missed: poll open charges and complete/expire them.
 * Also edits Telegram address messages when UI TTL or watch window ends.
 */
export async function checkOnchainCharges() {
  const {onchainPayments, satsPay, completeOnchainJoin, log} = getRuntime()
  const watchable = await onchainPayments.listWatchable(200)
  log.info(`Found ${watchable.length} open on-chain charges.`)

  for (const row of watchable) {
    try {
      const now = new Date()

      if (row.watchUntil.getTime() < now.getTime()) {
        const expired = await onchainPayments.markExpired(row.id)
        if (expired) await editOnchainStatusMessage(expired, 'onchain-invoice.expired')
        continue
      }

      if (row.status === 'pending' && row.expiresAt.getTime() < now.getTime()) {
        const graced = await onchainPayments.markGrace(row.id)
        if (graced) await editOnchainStatusMessage(graced, 'onchain-invoice.grace')
      }

      const current = (await onchainPayments.findById(row.id)) ?? row

      const charge = await satsPay.getCharge(current.satspayChargeId)
      if (charge.paid) {
        await completeOnchainJoin.complete(current, extractTxidFromChargeExtra(charge.extra))
        continue
      }

      if (current.status === 'grace' || current.expiresAt.getTime() < now.getTime()) {
        try {
          const refreshed = await satsPay.checkChargeBalance(current.satspayChargeId)
          if (refreshed.paid) {
            await completeOnchainJoin.complete(current, extractTxidFromChargeExtra(refreshed.extra))
          }
        } catch (error) {
          log.debug({error, chargeId: current.satspayChargeId}, 'checkChargeBalance skipped')
        }
      }
    } catch (error) {
      log.error(
        {error, chargeId: row.satspayChargeId, onchainId: row.id},
        'Failed to poll SatsPay charge',
      )
    }
  }
}
