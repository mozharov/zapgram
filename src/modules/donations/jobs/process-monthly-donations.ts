import {SendPausedError} from '@core/errors/send-paused.js'
import {advanceMonthlyNextAt} from '@core/money/donation.js'
import {formatUsdSuffix, satsToUsd} from '@core/money/usd.js'
import {classifyPayoutLookup, type PayoutState} from '@core/payments/payout-state.js'
import type {User} from '@infra/db/types.js'
import {captureUserEvent, captureUserException, errorProperties} from '@infra/posthog.js'
import {runBatch} from '@jobs/run-batch.js'
import {HTTPError} from 'got'
import {getRuntime} from '../../../runtime.js'

const FAIL_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Charge due monthly donations. Advances nextAt only after a successful pay.
 * Failure: stay due, throttled PM (once per 24h).
 */
export async function processMonthlyDonations(now: Date = new Date()): Promise<void> {
  const {log, users} = getRuntime()

  await runBatch({
    name: 'monthly donations',
    log,
    count: () => users.countDueMonthlyDonations(now),
    fetch: (limit, offset) => users.findDueMonthlyDonations(limit, offset, now),
    process: async (user: User) => {
      return processMonthlyDonation(getRuntime(), user, now)
    },
  })
}

type Runtime = ReturnType<typeof getRuntime>
export type MonthlyDonationDeps = Pick<Runtime, 'log' | 'posthog' | 'translate'> & {
  users: Pick<Runtime['users'], 'update'>
  donations: Pick<Runtime['donations'], 'findByPaymentHash' | 'insertDonation'>
  donationPay: Pick<Runtime['donationPay'], 'payDonation'>
  masterWallet: {lookupFeePayment: (hash: string) => Promise<{paid: boolean; status?: string}>}
  notifier: Pick<Runtime['notifier'], 'send'>
  rates: Pick<Runtime['rates'], 'getBtcUsd'>
}

/** Process one due period; uncertain outcomes stay due and can only be resolved by lookup. */
export async function processMonthlyDonation(
  deps: MonthlyDonationDeps,
  user: User,
  now: Date,
): Promise<'done' | 'keep'> {
  const {log, users, donations, donationPay, posthog, notifier, masterWallet, translate, rates} =
    deps
  const amount = user.monthlyDonationSats
  const baseProps = {
    feature: 'donations',
    flow: 'monthly_cron' as const,
    amount_sats: amount,
    has_nwc: Boolean(user.nwcUrl),
    previous_next_at: user.monthlyDonationNextAt?.toISOString() ?? null,
    language_code: user.languageCode,
  }

  if (amount <= 0) return 'done'

  // An uncertain pay owns this period until the fee wallet proves it settled or failed.
  if (user.monthlyDonationLastHash) {
    let state: PayoutState
    try {
      state = classifyPayoutLookup(
        await masterWallet.lookupFeePayment(user.monthlyDonationLastHash),
      )
    } catch (error) {
      if (error instanceof HTTPError && error.response.statusCode === 404) {
        state = 'retryable'
      } else {
        captureUserException(posthog, error, user.id, {
          ...baseProps,
          stage: 'lookup_last_hash',
          payment_hash: user.monthlyDonationLastHash,
        })
        return 'keep'
      }
    }
    if (state === 'pending') return 'keep'
    if (state === 'paid') {
      // A previous tick may have inserted the ledger before its schedule update failed.
      if (!(await donations.findByPaymentHash(user.monthlyDonationLastHash))) {
        await donations.insertDonation({
          userId: user.id,
          amountSats: amount,
          kind: 'monthly',
          paymentHash: user.monthlyDonationLastHash,
        })
      }
      const nextAt = advanceMonthlyNextAt(user.monthlyDonationNextAt ?? now, now)
      await users.update(user.id, {
        monthlyDonationNextAt: nextAt,
        monthlyDonationLastHash: null,
      })
      log.info(
        {userId: user.id, paymentHash: user.monthlyDonationLastHash},
        'Monthly donation recovered',
      )
      captureUserEvent(posthog, 'monthly_donate_recovered', user.id, {
        ...baseProps,
        payment_hash: user.monthlyDonationLastHash,
        next_at: nextAt.toISOString(),
        recovery: 'already_paid_hash',
      })
      return 'done'
    }
    // Release a definitively failed hash before attempting another payment.
    await users.update(user.id, {monthlyDonationLastHash: null})
  }

  const result = await donationPay.payDonation({
    userId: user.id,
    amountSats: amount,
    kind: 'monthly',
    rail: 'auto',
    nwcUrl: user.nwcUrl,
    analytics: {source: 'monthly_cron'},
  })

  if (result.status === 'paid') {
    const from = user.monthlyDonationNextAt ?? now
    const nextAt = advanceMonthlyNextAt(from, now)
    await users.update(user.id, {
      monthlyDonationNextAt: nextAt,
      monthlyDonationLastHash: null,
    })
    log.info({userId: user.id, paymentHash: result.paymentHash}, 'Monthly donation paid')
    captureUserEvent(posthog, 'monthly_donate_charged', user.id, {
      ...baseProps,
      status: 'paid',
      rail: result.rail,
      payment_hash: result.paymentHash ?? null,
      next_at: nextAt.toISOString(),
    })
    return 'done'
  }

  if (result.status === 'pending') {
    await users.update(user.id, {monthlyDonationLastHash: result.paymentHash})
    return 'keep'
  }

  const lastFail = user.monthlyDonationLastFailNotifyAt
  const shouldNotify = !lastFail || now.getTime() - lastFail.getTime() >= FAIL_NOTIFY_COOLDOWN_MS
  if (shouldNotify) {
    try {
      const btcUsd = await rates.getBtcUsd()
      const usdSuffix = btcUsd === null ? '' : formatUsdSuffix(satsToUsd(amount, btcUsd))
      const text =
        result.error instanceof SendPausedError
          ? translate('donate.monthly-charge-paused', user.languageCode, {
              sats: amount,
              usdSuffix,
            })
          : translate('donate.monthly-failed', user.languageCode, {
              sats: amount,
              usdSuffix,
            })
      await notifier.send(user.id, text)
      await users.update(user.id, {monthlyDonationLastFailNotifyAt: now})
    } catch (error) {
      captureUserException(posthog, error, user.id, {
        ...baseProps,
        stage: 'fail_notify',
        reason: result.reason,
      })
    }
  }

  captureUserEvent(posthog, 'monthly_donate_failed', user.id, {
    ...baseProps,
    status: 'failed',
    reason: result.reason,
    notified: shouldNotify,
    last_fail_notify_at: lastFail?.toISOString() ?? null,
    ...errorProperties(result.error),
  })
  return 'keep'
}
