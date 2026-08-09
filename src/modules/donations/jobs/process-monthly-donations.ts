import {advanceMonthlyNextAt} from '@core/money/donation.js'
import type {User} from '@infra/db/types.js'
import {captureUserEvent} from '@infra/posthog.js'
import {runBatch} from '@jobs/run-batch.js'
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
            return 'done'
          }
        } catch {
          // lookup failed — fall through to pay
        }
      }

      const result = await donationPay.payDonation({
        userId: user.id,
        amountSats: amount,
        kind: 'monthly',
        rail: 'auto',
        nwcUrl: user.nwcUrl,
      })

      if (result.status === 'paid') {
        const from = user.monthlyDonationNextAt ?? now
        const nextAt = advanceMonthlyNextAt(from, now)
        await users.update(user.id, {
          monthlyDonationNextAt: nextAt,
          monthlyDonationLastHash: result.paymentHash ?? null,
        })
        captureUserEvent(posthog, 'monthly_donate_charged', user.id, {
          amount_sats: amount,
          rail: result.rail,
          next_at: nextAt.toISOString(),
        })
        return 'done'
      }

      const lastFail = user.monthlyDonationLastFailNotifyAt
      const shouldNotify =
        !lastFail || now.getTime() - lastFail.getTime() >= FAIL_NOTIFY_COOLDOWN_MS
      if (shouldNotify) {
        const text = translate('donate.monthly-failed', user.languageCode, {sats: amount})
        await notifier.send(user.id, text)
        await users.update(user.id, {monthlyDonationLastFailNotifyAt: now})
      }

      captureUserEvent(posthog, 'monthly_donate_failed', user.id, {
        amount_sats: amount,
        reason: result.reason,
      })
      return 'keep'
    },
  })
}
