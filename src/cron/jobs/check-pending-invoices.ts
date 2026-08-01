import {logger} from '@infra/logger.js'
import {CronJob} from 'cron'
import {HTTPError} from 'got'
import {
  countPendingInvoices,
  deletePendingInvoice,
  getPendingInvoices,
} from '../../models/pending-invoice.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import {notifyInvoicePaid} from '../../services/notify-invoice-paid.js'

export const checkPendingInvoicesJob = CronJob.from({
  cronTime: '0 */2 * * * *',
  onTick: checkPendingInvoices,
  runOnInit: false,
  waitForCompletion: true,
})

const BATCH_SIZE = 10
async function checkPendingInvoices() {
  try {
    const total = await countPendingInvoices()
    logger.info(`Found ${total} pending invoices.`)
    if (total === 0) return

    let processed = 0
    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const invoices = await getPendingInvoices(BATCH_SIZE, offset)
      if (invoices.length === 0) break

      logger.info(`Processing batch of ${invoices.length} invoices.`)

      for (const invoice of invoices) {
        try {
          const wallet = await getUserWallet(invoice.userId)
          const payment = await wallet.lookupPayment(invoice.paymentHash)

          if (payment.paid) {
            await notifyInvoicePaid(invoice.paymentRequest, invoice.userId).catch(
              (error: unknown) => {
                logger.error({error}, 'Failed to notify user about paid invoice')
              },
            )
            await deletePendingInvoice(invoice.paymentRequest)
          }
        } catch (error) {
          logger.error({error}, `Error processing invoice ${invoice.paymentHash}.`)

          // Handle specific error types
          if (error instanceof HTTPError && error.response.statusCode === 404) {
            // Invoice not found on LNBits, likely expired or invalid
            logger.error(`Invoice ${invoice.paymentHash} not found on LNBits. Deleting.`)
            await deletePendingInvoice(invoice.paymentRequest).catch((deleteError: unknown) => {
              logger.error(
                {error: deleteError},
                `Failed to delete not-found invoice ${invoice.paymentRequest}`,
              )
            })
          } else if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') {
            // Timeout connecting to LNBits, keep the invoice for retry
            logger.warn(`Timeout checking invoice ${invoice.paymentHash}. Will retry later.`)
          } else {
            // Other unexpected error
            logger.error({error}, `Unhandled error processing invoice ${invoice.paymentHash}.`)
          }
        }
      }

      processed += invoices.length
    }

    logger.info(`Finished processing ${processed} invoices.`)
  } catch (error) {
    logger.error({error}, 'Error in checkPendingInvoices job.')
  }
}
