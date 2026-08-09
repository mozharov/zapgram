import type {SatsPayCharge} from '@infra/lnbits/schemas.js'
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

      // Always force SatsPay to re-query mempool (PUT balance). A plain GET only
      // returns stored state — if the extension's WS listener missed the tx, paid
      // never flips without this. Primary path is still SatsPay webhook.
      let charge: SatsPayCharge
      try {
        charge = await satsPay.checkChargeBalance(current.satspayChargeId)
      } catch (error) {
        log.debug(
          {error, chargeId: current.satspayChargeId},
          'checkChargeBalance failed; falling back to getCharge',
        )
        charge = await satsPay.getCharge(current.satspayChargeId)
      }

      if (charge.paid) {
        await completeOnchainJoin.complete(current, extractTxidFromChargeExtra(charge.extra))
      }
    } catch (error) {
      log.error(
        {error, chargeId: row.satspayChargeId, onchainId: row.id},
        'Failed to poll SatsPay charge',
      )
    }
  }
}
