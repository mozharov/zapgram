import {logger} from '@infra/logger.js'
import {runBatch} from '@jobs/run-batch.js'
import {notifyInvoicePaid} from '@modules/invoices/notify-invoice-paid.js'
import {
  countPendingInvoices,
  deletePendingInvoice,
  getPendingInvoices,
} from '@modules/invoices/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {HTTPError} from 'got'

export async function checkPendingInvoices(): Promise<void> {
  try {
    await runBatch({
      name: 'pending invoices',
      log: logger,
      count: () => countPendingInvoices(),
      fetch: (limit, offset) => getPendingInvoices(limit, offset),
      process: async invoice => {
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
            return 'done'
          }
          return 'keep'
        } catch (error) {
          logger.error({error}, `Error processing invoice ${invoice.paymentHash}.`)

          if (error instanceof HTTPError && error.response.statusCode === 404) {
            logger.error(`Invoice ${invoice.paymentHash} not found on LNBits. Deleting.`)
            await deletePendingInvoice(invoice.paymentRequest).catch((deleteError: unknown) => {
              logger.error(
                {error: deleteError},
                `Failed to delete not-found invoice ${invoice.paymentRequest}`,
              )
            })
            return 'done'
          }
          if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') {
            logger.warn(`Timeout checking invoice ${invoice.paymentHash}. Will retry later.`)
            return 'keep'
          }
          logger.error({error}, `Unhandled error processing invoice ${invoice.paymentHash}.`)
          return 'keep'
        }
      },
    })
  } catch (error) {
    logger.error({error}, 'Error in checkPendingInvoices job.')
  }
}
