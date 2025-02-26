import {nwc} from '@getalby/sdk'
import {NoNWCAnswerError} from '../bot/errors/no-nwc-answer.js'
import {NWCPaymentFailedError} from '../bot/errors/nwc-payment-failed.js'
import {InsufficientFundsError} from '../bot/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '../bot/errors/invoice-already-paid.js'
import {NWCTimeoutError} from '../bot/errors/nwc-timeout.js'
import {logger} from './logger.js'
import {buildInvoiceMemo} from '../helpers/memo.js'

export class NostrWallet {
  private readonly client: nwc.NWCClient
  public readonly nwcUrl: string

  constructor(nwcUrl: string) {
    this.client = new nwc.NWCClient({
      nostrWalletConnectUrl: nwcUrl,
    })
    this.nwcUrl = nwcUrl
  }

  /**
   * @returns balance in millisats
   */
  public async getBalance() {
    return withTimeout(this.client.getBalance().then(result => result.balance))
  }

  // expiry is in seconds. Default is 1 day.
  public async createInvoice(msats: number, memo = '', expiry = 60 * 60 * 24 * 1) {
    const description = buildInvoiceMemo(memo)
    return withTimeout(this.client.makeInvoice({amount: msats, description, expiry}))
  }

  public async lookupInvoice(invoice: string) {
    return withTimeout(this.client.lookupInvoice({invoice}))
  }

  public async payInvoice(invoice: string) {
    try {
      await withTimeout(this.client.payInvoice({invoice}))
    } catch (error) {
      // some wallet don't return success response after payment, but invoice is paid
      if (!(error instanceof nwc.Nip47Error) || !error.message.includes('already been paid')) {
        const lookup = await this.lookupInvoice(invoice).catch(() => ({preimage: null}))
        if (lookup.preimage) return
      }
      handlePayInvoiceError(error)
    }
  }
}

function handlePayInvoiceError(error: unknown) {
  logger.error({error}, 'Error while paying invoice')
  if (
    error instanceof nwc.Nip47TimeoutError ||
    error instanceof NWCTimeoutError ||
    error instanceof nwc.Nip47ResponseValidationError
  ) {
    throw new NoNWCAnswerError({message: error.message})
  }
  if (error instanceof nwc.Nip47Error) {
    if (error.message.startsWith('Could not pay')) {
      throw new NWCPaymentFailedError()
    }
    if (error.message.startsWith('Insufficient balance')) {
      throw new InsufficientFundsError()
    }
    if (error.message.includes('already been paid')) {
      throw new InvoiceAlreadyPaidError()
    }
  }
  throw new Error('Unknown error while paying invoice')
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  const timeout = 8000 // 8 seconds. Default NWC timeout is too long.
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new NWCTimeoutError())
    }, timeout)
  })
  return Promise.race([promise, timeoutPromise])
}
