import {captureUserEvent} from '@infra/posthog.js'
import {runBatch} from '@jobs/run-batch.js'
import {isOnchainPaymentHash} from '@modules/onchain/complete.service.js'
import {
  countExhaustedSubscriptionPayments,
  countSubscriptionPayments,
  deleteSubscriptionPayment,
  getSubscriptionPayments,
} from '@modules/subscriptions/payment-repository.js'
import {completeSubscriptionPayment} from '@modules/subscriptions/settle.js'
import {getRuntime} from '../../../runtime.js'

export async function checkSubscriptionPayments(): Promise<void> {
  try {
    const exhausted = await countExhaustedSubscriptionPayments()
    if (exhausted > 0) {
      getRuntime().log.error(
        {exhausted},
        'Subscription payments are stuck past their settle attempt budget and need manual review.',
      )
    }

    await runBatch({
      name: 'pending subscription payments',
      log: getRuntime().log,
      count: () => countSubscriptionPayments(),
      fetch: (limit, offset) => getSubscriptionPayments(limit, offset),
      process: async payment => {
        try {
          // Synthetic on-chain attempts use payment_hash `onchain:{chargeId}` — not LNbits LN.
          // Completion is webhook + check-onchain-charges only.
          if (isOnchainPaymentHash(payment.paymentHash)) return 'keep'

          const data = await getRuntime().masterWallet.lookupPayment(payment.paymentHash)
          if (data.paid) {
            // subscription_settled / subscription_duplicate_refunded fire inside settle.
            return (await completeSubscriptionPayment(payment)) === 'kept' ? 'keep' : 'done'
          }
          if (data.details.expiry && data.details.expiry < new Date()) {
            getRuntime().log.info(
              {paymentHash: payment.paymentHash},
              'Subscription payment expired.',
            )
            await deleteSubscriptionPayment(payment.id)
            captureUserEvent(
              getRuntime().posthog,
              'subscription_payment_expired',
              payment.userId,
              {
                payment_id: payment.id,
                chat_id: payment.chatId,
                kind: payment.kind,
                amount_sats: payment.price,
                subscription_type: payment.subscriptionType,
              },
              {chatId: payment.chatId},
            )
            return 'done'
          }
          return 'keep'
        } catch (error) {
          getRuntime().log.error(
            {error, paymentHash: payment.paymentHash},
            'Error processing subscription payment.',
          )
          return 'keep'
        }
      },
    })
  } catch (error) {
    getRuntime().log.error({error}, 'Error in checkSubscriptionPayments job.')
  }
}
