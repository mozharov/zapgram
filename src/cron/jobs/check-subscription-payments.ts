import {CronJob} from 'cron'
import {lnbitsMasterWallet} from '../../lib/lnbits/master-wallet.js'
import {logger} from '../../lib/logger.js'
import {
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
    const total = await countSubscriptionPayments()
    logger.info(`Found ${total} pending subcription payments.`)
    if (total === 0) return

    let processed = 0
    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const payments = await getSubscriptionPayments(BATCH_SIZE, offset)
      if (payments.length === 0) break

      logger.info(`Processing batch of ${payments.length} subscription payments.`)

      for (const payment of payments) {
        try {
          const data = await lnbitsMasterWallet.lookupPayment(payment.paymentHash)
          if (data.paid) {
            await completeSubscriptionPayment(payment)
          } else if (data.details.expiry && data.details.expiry < new Date()) {
            logger.info({paymentHash: payment.paymentHash}, 'Subscription payment expired.')
            await deleteSubscriptionPayment(payment.id)
          }
        } catch (error) {
          logger.error(
            {error, paymentHash: payment.paymentHash},
            'Error processing subscription payment.',
          )
        }
      }

      processed += payments.length
    }

    logger.info(`Finished processing ${processed} subscription payments.`)
  } catch (error) {
    logger.error({error}, 'Error in checkSubscriptionPayments job.')
  }
}
