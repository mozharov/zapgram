import {InsufficientFundsError} from '@core/errors/insufficient-funds.js'
import {InvoiceAlreadyPaidError} from '@core/errors/invoice-already-paid.js'
import {NoNWCAnswerError} from '@core/errors/no-nwc-answer.js'
import {NWCPaymentFailedError} from '@core/errors/nwc-payment-failed.js'
import {NWCTimeoutError} from '@core/errors/nwc-timeout.js'
import {buildInvoiceMemo} from '@core/lightning/memo.js'
import {Nip47Error, Nip47ResponseValidationError, Nip47TimeoutError, NWCClient} from '@getalby/sdk'
import type {AppLogger} from '../logger.js'

export class NostrWallet {
  private readonly client: NWCClient
  public readonly nwcUrl: string
  private readonly memoFooter: string
  private readonly log?: AppLogger

  constructor(nwcUrl: string, memoFooter = '', log?: AppLogger) {
    this.client = new NWCClient({
      nostrWalletConnectUrl: nwcUrl,
    })
    this.nwcUrl = nwcUrl
    this.memoFooter = memoFooter
    this.log = log
  }

  /**
   * @returns balance in millisats
   */
  public async getBalance() {
    return withTimeout(this.client.getBalance().then(result => result.balance))
  }

  // expiry is in seconds. Default is 1 day.
  public async createInvoice(msats: number, memo = '', expiry = 60 * 60 * 24 * 1) {
    const description = buildInvoiceMemo(memo, this.memoFooter)
    return withTimeout(this.client.makeInvoice({amount: msats, description, expiry}))
  }

  public async lookupInvoice(invoice: string) {
    return withTimeout(this.client.lookupInvoice({invoice}))
  }

  public async payInvoice(invoice: string, timeout = true) {
    try {
      if (timeout) await withTimeout(this.client.payInvoice({invoice}))
      else await this.client.payInvoice({invoice})
    } catch (error) {
      // some wallet don't return success response after payment, but invoice is paid
      if (!(error instanceof Nip47Error) || !error.message.includes('already been paid')) {
        const lookup = await this.lookupInvoice(invoice).catch(() => ({preimage: null}))
        if (lookup.preimage) return
      }
      handlePayInvoiceError(error, this.log)
    }
  }
}

function handlePayInvoiceError(error: unknown, log?: AppLogger) {
  log?.error({error}, 'Error while paying invoice')
  if (
    error instanceof Nip47TimeoutError ||
    error instanceof NWCTimeoutError ||
    error instanceof Nip47ResponseValidationError
  ) {
    throw new NoNWCAnswerError({message: error.message})
  }
  if (error instanceof Nip47Error) {
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
