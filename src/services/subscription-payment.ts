import {HTTPError} from 'got'
import {config} from '../config.js'
import type {SubscriptionPayment, User} from '../lib/database/types.js'
import {lnbitsMasterWallet} from '../lib/lnbits/master-wallet.js'
import {classifyPayoutLookup, type PayoutState} from '../lib/lnbits/payout-state.js'
import {logger} from '../lib/logger.js'
import {computeSubscriptionFee} from '../lib/money/fee.js'
import {recordFeePayoutInvoice, recordPayoutInvoice} from '../models/subscription-payment.js'
import {getUserOrThrow} from '../models/user.js'
import {getUserWallet} from './lnbits-user-wallet.js'

export type DistributeOnceResult = {status: 'paid'; fee: number} | {status: 'pending'}

/**
 * Moves the money for a subscription payment at most once: `price - fee` to the chat owner, then
 * `fee` to the fee-collection wallet.
 *
 * Each transfer is its own leg with its own stored hash, so a crash between them cannot re-send the
 * one that already went through. Returns `pending` when LNbits reports a transfer still in flight —
 * the caller must leave the payment row alone and re-check later rather than paying again.
 */
export async function distributeSubscriptionPaymentOnce(
  payment: SubscriptionPayment,
  chatOwnerId: User['id'],
): Promise<DistributeOnceResult> {
  const fee = computeSubscriptionFee(payment.price, config.SUBSCRIPTION_FEE_PERCENT)

  const ownerLeg = await settleLeg({
    storedHash: payment.payoutHash,
    label: 'owner payout',
    paymentId: payment.id,
    createInvoice: () => createOwnerPayoutInvoice(chatOwnerId, payment.price - fee),
    persistHash: hash => recordPayoutInvoice(payment.id, hash),
  })
  if (ownerLeg === 'pending') return {status: 'pending'}

  if (fee > 0) {
    const feeLeg = await settleLeg({
      storedHash: payment.feePayoutHash,
      label: 'fee collection',
      paymentId: payment.id,
      createInvoice: () => lnbitsMasterWallet.createFeeCollectionInvoice(fee),
      persistHash: hash => recordFeePayoutInvoice(payment.id, hash),
    })
    if (feeLeg === 'pending') return {status: 'pending'}
  }

  return {status: 'paid', fee}
}

/**
 * One idempotent outgoing transfer.
 *
 * The hash is persisted *before* the invoice is paid — that ordering is the whole guarantee. A fresh
 * invoice is only issued once LNbits confirms no successful payment exists for the stored hash,
 * which also means an expired invoice from an earlier attempt is simply replaced.
 */
async function settleLeg({
  storedHash,
  label,
  paymentId,
  createInvoice,
  persistHash,
}: {
  storedHash: string | null
  label: string
  paymentId: SubscriptionPayment['id']
  createInvoice: () => Promise<{payment_hash: string; bolt11: string}>
  persistHash: (hash: string) => Promise<void>
}): Promise<'paid' | 'pending'> {
  if (storedHash) {
    const state = await lookupPayoutState(storedHash)
    if (state === 'paid') {
      logger.info({paymentId, hash: storedHash}, `${label} already settled; skipping.`)
      return 'paid'
    }
    if (state === 'pending') {
      logger.info({paymentId, hash: storedHash}, `${label} still in flight; not re-sending.`)
      return 'pending'
    }
  }

  const invoice = await createInvoice()
  await persistHash(invoice.payment_hash)
  await lnbitsMasterWallet.payInvoice(invoice.bolt11)
  return 'paid'
}

async function createOwnerPayoutInvoice(chatOwnerId: User['id'], sats: number) {
  const owner = await getUserOrThrow(chatOwnerId)
  const ownerWallet = await getUserWallet(owner.id)
  return ownerWallet.createInvoice({sats})
}

/** A 404 means the master wallet has no payment with this hash, so re-paying is safe. */
async function lookupPayoutState(hash: string): Promise<PayoutState> {
  try {
    return classifyPayoutLookup(await lnbitsMasterWallet.lookupPayment(hash))
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 404) return 'retryable'
    throw error
  }
}
