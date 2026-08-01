import {lnbitsMasterWallet} from '@infra/lnbits/master-wallet.js'
import {logger} from '@infra/logger.js'
import {runBatch} from '@jobs/run-batch.js'
import {
  countExhaustedSubscriptionPayments,
  countSubscriptionPayments,
  deleteSubscriptionPayment,
  getSubscriptionPayments,
} from '@modules/subscriptions/payment-repository.js'
import {completeSubscriptionPayment} from '@modules/subscriptions/settle.js'

export async function checkSubscriptionPayments(): Promise<void> {
  try {
    const exhausted = await countExhaustedSubscriptionPayments()
    if (exhausted > 0) {
      logger.error(
        {exhausted},
        'Subscription payments are stuck past their settle attempt budget and need manual review.',
      )
    }

    await runBatch({
      name: 'pending subscription payments',
      log: logger,
      count: () => countSubscriptionPayments(),
      fetch: (limit, offset) => getSubscriptionPayments(limit, offset),
      process: async payment => {
        try {
          const data = await lnbitsMasterWallet.lookupPayment(payment.paymentHash)
          if (data.paid) {
            return (await completeSubscriptionPayment(payment)) === 'kept' ? 'keep' : 'done'
          }
          if (data.details.expiry && data.details.expiry < new Date()) {
            logger.info({paymentHash: payment.paymentHash}, 'Subscription payment expired.')
            await deleteSubscriptionPayment(payment.id)
            return 'done'
          }
          return 'keep'
        } catch (error) {
          logger.error(
            {error, paymentHash: payment.paymentHash},
            'Error processing subscription payment.',
          )
          return 'keep'
        }
      },
    })
  } catch (error) {
    logger.error({error}, 'Error in checkSubscriptionPayments job.')
  }
}
