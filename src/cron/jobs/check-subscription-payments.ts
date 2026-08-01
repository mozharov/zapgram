import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {logger} from '@infra/logger.js'
import {CronJob} from 'cron'
import {
  countExhaustedSubscriptionPayments,
  countSubscriptionPayments,
  deleteSubscriptionPayment,
  getSubscriptionPayments,
} from '../../models/subscription-payment.js'
import {completeSubscriptionPayment} from '../../services/complete-subscription-payment.js'

export const checkSubscriptionPaymentsJob = CronJob.from({
  cronTime: '0 */3 * * * *',
  onTick: checkSubscriptionPayments,
  runOnInit: false,
  waitForCompletion: true,
})

const BATCH_SIZE = 10
async function checkSubscriptionPayments() {
  try {
    const exhausted = await countExhaustedSubscriptionPayments()
    if (exhausted > 0) {
      logger.error(
        {exhausted},
        'Subscription payments are stuck past their settle attempt budget and need manual review.',
      )
    }

    const total = await countSubscriptionPayments()
    logger.info(`Found ${total} pending subcription payments.`)
    if (total === 0) return

    let processed = 0
    // Settled and expired payments are deleted while we iterate, which shifts the remaining rows
    // left. Advancing `offset` by a fixed BATCH_SIZE would therefore skip exactly as many payments
    // as this batch removed, so it only moves past the rows that survived.
    let offset = 0
    while (true) {
      const payments = await getSubscriptionPayments(BATCH_SIZE, offset)
      if (payments.length === 0) break

      logger.info(`Processing batch of ${payments.length} subscription payments.`)

      let kept = 0
      for (const payment of payments) {
        try {
          const data = await lnbitsMasterWallet.lookupPayment(payment.paymentHash)
          if (data.paid) {
            if ((await completeSubscriptionPayment(payment)) === 'kept') kept++
          } else if (data.details.expiry && data.details.expiry < new Date()) {
            logger.info({paymentHash: payment.paymentHash}, 'Subscription payment expired.')
            await deleteSubscriptionPayment(payment.id)
          } else {
            kept++
          }
        } catch (error) {
          logger.error(
            {error, paymentHash: payment.paymentHash},
            'Error processing subscription payment.',
          )
          kept++
        }
      }

      processed += payments.length
      offset += kept
    }

    logger.info(`Finished processing ${processed} subscription payments.`)
  } catch (error) {
    logger.error({error}, 'Error in checkSubscriptionPayments job.')
  }
}
