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
import {captureUserEvent} from '@infra/posthog.js'
import type {DonationPayRail, DonationPayService, PayDonationResult} from './pay.service.js'

export type CollectDonationResult =
  | {status: 'skipped'; reason: 'off' | 'zero' | 'scope'}
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
    try {
      const user =
        input.user ??
        (await deps.getUser(input.userId).catch(error => {
          deps.log.error({error, userId: input.userId}, 'tryCollect: user load failed')
          return null
        }))
      if (!user) return {status: 'skipped', reason: 'off'}

      const percent = user.donationPercent
      const scope = user.donationScope as DonationScope
      if (!percent || percent <= 0) return {status: 'skipped', reason: 'off'}
      if (!shouldApplyDonation(scope, input.kind)) return {status: 'skipped', reason: 'scope'}

      const amountSats = computeDonationSats(input.baseAmountSats, percent)
      if (amountSats <= 0) return {status: 'skipped', reason: 'zero'}

      const payResult: PayDonationResult = await deps.payService.payToFeeCollection({
        userId: input.userId,
        amountSats,
        rail: input.preferredRail,
        nwc: input.nwc,
        nwcUrl: input.nwcUrl ?? user.nwcUrl,
      })

      if (payResult.status === 'paid') {
        try {
          await deps.insertDonation({
            userId: input.userId,
            amountSats,
            kind: 'percent',
            paymentHash: payResult.paymentHash,
          })
        } catch (error) {
          deps.log.error({error, userId: input.userId}, 'tryCollect: ledger insert failed')
        }

        captureUserEvent(deps.posthog, 'donation_collected', input.userId, {
          amount_sats: amountSats,
          base_amount_sats: input.baseAmountSats,
          percent,
          kind: input.kind,
          rail: payResult.rail,
        })
        return {
          status: 'collected',
          amountSats,
          rail: payResult.rail,
          paymentHash: payResult.paymentHash,
        }
      }

      captureUserEvent(deps.posthog, 'donation_failed', input.userId, {
        amount_sats: amountSats,
        base_amount_sats: input.baseAmountSats,
        percent,
        kind: input.kind,
        reason: payResult.reason,
      })

      await deps.notifyDonationFailed(input.userId, amountSats, user.languageCode).catch(error => {
        deps.log.error({error, userId: input.userId}, 'tryCollect: fail notify failed')
      })

      return {status: 'failed', amountSats, error: payResult.error}
    } catch (error) {
      deps.log.error({error, userId: input.userId}, 'tryCollect: unexpected error')
      return {status: 'failed', amountSats: 0, error}
    }
  }

  return {tryCollect}
}

export type DonationCollectService = ReturnType<typeof createDonationCollectService>
