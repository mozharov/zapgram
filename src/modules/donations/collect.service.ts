import {
  computeDonationSats,
  type DonationPaymentKind,
  type DonationScope,
  shouldApplyDonation,
} from '@core/money/donation.js'
import type {User} from '@infra/db/types.js'
import type {AppLogger} from '@infra/logger.js'
import type {NostrWallet} from '@infra/nostr/wallet.js'
import type {CaptureClient} from '@infra/posthog.js'
import {captureUserEvent, captureUserException, errorProperties} from '@infra/posthog.js'
import type {DonationPayRail, DonationPayService, PayDonationResult} from './pay.service.js'

export type CollectDonationResult =
  | {status: 'skipped'; reason: 'off' | 'zero' | 'scope' | 'user_missing'}
  | {status: 'collected'; amountSats: number; rail: DonationPayRail; paymentHash?: string}
  | {status: 'failed'; amountSats: number; error: unknown}

export type CollectDonationDeps = {
  payService: Pick<DonationPayService, 'payToFeeCollection'>
  insertDonation: (input: {
    userId: number
    amountSats: number
    kind: 'percent'
    paymentHash?: string | null
  }) => Promise<unknown>
  getUser: (userId: User['id']) => Promise<User>
  /** Never-throw PM on auto-% failure. */
  notifyDonationFailed: (
    userId: number,
    donationSats: number,
    languageCode: string,
  ) => Promise<void>
  log: AppLogger
  posthog?: CaptureClient
}

/**
 * Best-effort voluntary % collection after a successful tip or invoice pay.
 * Never throws — main payment already succeeded.
 */
export function createDonationCollectService(deps: CollectDonationDeps) {
  async function tryCollect(input: {
    userId: number
    baseAmountSats: number
    kind: DonationPaymentKind
    /** Prefer the same rail as the main payment when possible. */
    preferredRail: DonationPayRail
    nwc?: NostrWallet
    nwcUrl?: string | null
    /** When set, skip DB load for percent/scope/language. */
    user?: Pick<User, 'donationPercent' | 'donationScope' | 'languageCode' | 'nwcUrl'>
  }): Promise<CollectDonationResult> {
    const baseAnalytics = {
      feature: 'donations',
      flow: 'percent' as const,
      user_id: input.userId,
      base_amount_sats: input.baseAmountSats,
      payment_kind: input.kind,
      preferred_rail: input.preferredRail,
      has_nwc: Boolean(input.nwc || input.nwcUrl),
    }

    try {
      const user =
        input.user ??
        (await deps.getUser(input.userId).catch(error => {
          deps.log.error({error, userId: input.userId}, 'tryCollect: user load failed')
          captureUserException(deps.posthog, error, input.userId, {
            ...baseAnalytics,
            stage: 'load_user',
          })
          return null
        }))
      if (!user) {
        captureUserEvent(deps.posthog, 'donation_skipped', input.userId, {
          ...baseAnalytics,
          skip_reason: 'user_missing',
        })
        return {status: 'skipped', reason: 'user_missing'}
      }

      const percent = user.donationPercent
      const scope = user.donationScope as DonationScope
      if (!percent || percent <= 0) {
        // Extremely common when % is off — skip event to avoid noise.
        return {status: 'skipped', reason: 'off'}
      }
      if (!shouldApplyDonation(scope, input.kind)) {
        captureUserEvent(deps.posthog, 'donation_skipped', input.userId, {
          ...baseAnalytics,
          skip_reason: 'scope',
          donation_percent: percent,
          donation_scope: scope,
        })
        return {status: 'skipped', reason: 'scope'}
      }

      const amountSats = computeDonationSats(input.baseAmountSats, percent)
      if (amountSats <= 0) {
        captureUserEvent(deps.posthog, 'donation_skipped', input.userId, {
          ...baseAnalytics,
          skip_reason: 'zero',
          donation_percent: percent,
          donation_scope: scope,
        })
        return {status: 'skipped', reason: 'zero'}
      }

      const collectProps = {
        ...baseAnalytics,
        amount_sats: amountSats,
        donation_percent: percent,
        donation_scope: scope,
      }

      const payResult: PayDonationResult = await deps.payService.payToFeeCollection({
        userId: input.userId,
        amountSats,
        rail: input.preferredRail,
        nwc: input.nwc,
        nwcUrl: input.nwcUrl ?? user.nwcUrl,
      })

      if (payResult.status === 'paid') {
        let ledgerOk = true
        try {
          await deps.insertDonation({
            userId: input.userId,
            amountSats,
            kind: 'percent',
            paymentHash: payResult.paymentHash,
          })
        } catch (error) {
          ledgerOk = false
          deps.log.error({error, userId: input.userId}, 'tryCollect: ledger insert failed')
          captureUserException(deps.posthog, error, input.userId, {
            ...collectProps,
            stage: 'ledger_insert',
            rail: payResult.rail,
            payment_hash: payResult.paymentHash ?? null,
          })
          captureUserEvent(deps.posthog, 'donation_ledger_failed', input.userId, {
            ...collectProps,
            rail: payResult.rail,
            payment_hash: payResult.paymentHash ?? null,
            ...errorProperties(error),
          })
        }

        captureUserEvent(deps.posthog, 'donation_collected', input.userId, {
          ...collectProps,
          status: 'paid',
          rail: payResult.rail,
          payment_hash: payResult.paymentHash ?? null,
          ledger_written: ledgerOk,
        })
        return {
          status: 'collected',
          amountSats,
          rail: payResult.rail,
          paymentHash: payResult.paymentHash,
        }
      }

      captureUserEvent(deps.posthog, 'donation_failed', input.userId, {
        ...collectProps,
        status: 'failed',
        reason: payResult.reason,
        ...errorProperties(payResult.error),
      })
      if (payResult.error) {
        captureUserException(deps.posthog, payResult.error, input.userId, {
          ...collectProps,
          stage: 'try_collect_pay',
          reason: payResult.reason,
        })
      }

      await deps.notifyDonationFailed(input.userId, amountSats, user.languageCode).catch(error => {
        deps.log.error({error, userId: input.userId}, 'tryCollect: fail notify failed')
        captureUserException(deps.posthog, error, input.userId, {
          ...collectProps,
          stage: 'fail_notify',
        })
      })

      return {status: 'failed', amountSats, error: payResult.error}
    } catch (error) {
      deps.log.error({error, userId: input.userId}, 'tryCollect: unexpected error')
      captureUserException(deps.posthog, error, input.userId, {
        ...baseAnalytics,
        stage: 'try_collect_unexpected',
      })
      captureUserEvent(deps.posthog, 'donation_failed', input.userId, {
        ...baseAnalytics,
        status: 'failed',
        reason: 'unexpected',
        amount_sats: 0,
        ...errorProperties(error),
      })
      return {status: 'failed', amountSats: 0, error}
    }
  }

  return {tryCollect}
}

export type DonationCollectService = ReturnType<typeof createDonationCollectService>
