import {advanceMonthlyNextAt} from '@core/money/donation.js'
import type {User} from '@infra/db/types.js'
import {captureUserEvent, captureUserException, errorProperties} from '@infra/posthog.js'
import {runBatch} from '@jobs/run-batch.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../runtime.js'

const FAIL_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Charge due monthly donations. Advances nextAt only after a successful pay.
 * Failure: stay due, throttled PM (once per 24h).
 */
export async function processMonthlyDonations(now: Date = new Date()): Promise<void> {
  const {log, users, donationPay, posthog, notifier, masterWallet, translate} = getRuntime()

  await runBatch({
    name: 'monthly donations',
    log,
    count: () => users.countDueMonthlyDonations(now),
    fetch: (limit, offset) => users.findDueMonthlyDonations(limit, offset, now),
    process: async (user: User) => {
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

      // Light idempotency: if last hash already paid, advance schedule without re-pay.
      if (user.monthlyDonationLastHash) {
        try {
          const lookup = await masterWallet.lookupPayment(user.monthlyDonationLastHash)
          if (lookup.paid) {
            const from = user.monthlyDonationNextAt ?? now
            const nextAt = advanceMonthlyNextAt(from, now)
            await users.update(user.id, {
              monthlyDonationNextAt: nextAt,
              monthlyDonationLastHash: null,
            })
            captureUserEvent(posthog, 'monthly_donate_recovered', user.id, {
              ...baseProps,
              payment_hash: user.monthlyDonationLastHash,
              next_at: nextAt.toISOString(),
              recovery: 'already_paid_hash',
            })
            return 'done'
          }
        } catch (error) {
          captureUserException(posthog, error, user.id, {
            ...baseProps,
            stage: 'lookup_last_hash',
            payment_hash: user.monthlyDonationLastHash,
          })
          // fall through to pay
        }
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
          monthlyDonationLastHash: result.paymentHash ?? null,
        })
        captureUserEvent(posthog, 'monthly_donate_charged', user.id, {
          ...baseProps,
          status: 'paid',
          rail: result.rail,
          payment_hash: result.paymentHash ?? null,
          next_at: nextAt.toISOString(),
        })
        return 'done'
      }

      const lastFail = user.monthlyDonationLastFailNotifyAt
      const shouldNotify =
        !lastFail || now.getTime() - lastFail.getTime() >= FAIL_NOTIFY_COOLDOWN_MS
      if (shouldNotify) {
        try {
          const text = translate('donate.monthly-failed', user.languageCode, {
            sats: amount,
            usdSuffix: await usdSuffixForSats(amount),
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
    },
  })
}
