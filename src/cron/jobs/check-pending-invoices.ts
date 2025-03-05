import {CronJob} from 'cron'
import {notifyInvoicePaid} from '../../services/notify-invoice-paid.js'
import {logger} from '../../lib/logger.js'
import {
  getPendingInvoices,
  countPendingInvoices,
  deletePendingInvoice,
} from '../../models/pending-invoice.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import {HTTPError} from 'got'

export const checkPendingInvoicesJob = CronJob.from({
  cronTime: '0 */2 * * * *',
  onTick: checkPendingInvoices,
  runOnInit: false,
  waitForCompletion: true,
})

const BATCH_SIZE = 10
async function checkPendingInvoices() {
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
        if (error instanceof HTTPError && error.response.statusCode === 404) {
          logger.warn(`Invoice ${invoice.paymentHash} not found.`)
          continue
        }
        logger.error({error}, `Error processing invoice ${invoice.paymentHash}.`)
        await deletePendingInvoice(invoice.paymentRequest)
      }
    }

    processed += invoices.length
  }

  logger.info(`Finished processing ${processed} invoices.`)
}
