import type {AppLogger} from '@infra/logger.js'
import type {NostrWallet} from '@infra/nostr/wallet.js'
import type {CaptureClient} from '@infra/posthog.js'
import {captureUserEvent, captureUserException, errorProperties} from '@infra/posthog.js'
import type {DonationPayService} from '@modules/donations/pay.service.js'
import type {Notifier} from '@modules/notifications/notifier.js'

export type FeatureFundStatus = 'skipped' | 'paid' | 'pay_failed'

export type FeatureRequestSourceMessage = {
  chatId: number
  messageId: number
  /** Text for analytics (command payload or full free-text body). */
  text: string
}

export type SubmitFeatureRequestResult = {
  fundStatus: FeatureFundStatus
  amountPaidSats: number
  adminNotified: number
}

export type FeatureRequestSubmitDeps = {
  payDonation: DonationPayService['payDonation']
  notify: Notifier['send']
  copyMessage: Notifier['copyMessage']
  adminTelegramIds: readonly number[]
  /** English HTML meta line(s) before the copied user message. */
  formatAdminMeta: (input: {
    userId: number
    username: string | null
    firstName: string | null
    amountPaidSats: number
    fundStatus: FeatureFundStatus
  }) => string
  log: AppLogger
  posthog?: CaptureClient
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Submit a feature request: optional one-shot tip, PostHog event, admin meta + copyMessage.
 * Sats are an optional signal tip — not escrow and not a promise to ship.
 */
export function createFeatureRequestService(deps: FeatureRequestSubmitDeps) {
  async function submit(input: {
    userId: number
    username?: string | null
    firstName?: string | null
    source: FeatureRequestSourceMessage
    amountSats: number
    nwcUrl?: string | null
    nwc?: NostrWallet
  }): Promise<SubmitFeatureRequestResult> {
    const username = input.username ?? null
    const firstName = input.firstName ?? null
    const text = input.source.text
    let fundStatus: FeatureFundStatus = 'skipped'
    let amountPaidSats = 0
    let rail: string | null = null

    if (input.amountSats > 0) {
      try {
        const result = await deps.payDonation({
          userId: input.userId,
          amountSats: input.amountSats,
          kind: 'one_shot',
          rail: 'auto',
          nwc: input.nwc,
          nwcUrl: input.nwcUrl,
          analytics: {source: 'feature_request'},
        })
        if (result.status === 'paid') {
          fundStatus = 'paid'
          amountPaidSats = input.amountSats
          rail = result.rail
        } else {
          fundStatus = 'pay_failed'
          deps.log.warn(
            {userId: input.userId, reason: result.reason, amountSats: input.amountSats},
            'Feature request fund payment failed; submitting without sats',
          )
        }
      } catch (error) {
        fundStatus = 'pay_failed'
        deps.log.error({error, userId: input.userId}, 'Feature request fund threw')
        captureUserException(deps.posthog, error, input.userId, {
          feature: 'feature_requests',
          stage: 'fund_pay',
          amount_sats: input.amountSats,
        })
      }
    }

    captureUserEvent(deps.posthog, 'feature_requested', input.userId, {
      feature: 'feature_requests',
      // Full body up to Telegram message size; Activity / HogQL can show it.
      feature_text: text.slice(0, 4096),
      feature_text_length: text.length,
      amount_sats: amountPaidSats,
      amount_requested_sats: input.amountSats,
      funded: amountPaidSats > 0,
      fund_status: fundStatus,
      rail,
      username,
    })

    const meta = deps.formatAdminMeta({
      userId: input.userId,
      username,
      firstName,
      amountPaidSats,
      fundStatus,
    })

    let adminNotified = 0
    for (const adminId of deps.adminTelegramIds) {
      try {
        const metaOk = await deps.notify(adminId, meta)
        const copyOk = await deps.copyMessage(adminId, input.source.chatId, input.source.messageId)
        if (metaOk || copyOk) adminNotified += 1
        if (!copyOk) {
          deps.log.warn(
            {adminId, fromChatId: input.source.chatId, messageId: input.source.messageId},
            'Feature request copyMessage failed; meta may still have been sent',
          )
        }
      } catch (error) {
        deps.log.error({error, adminId}, 'Failed to notify admin of feature request')
        captureUserException(deps.posthog, error, input.userId, {
          feature: 'feature_requests',
          stage: 'admin_notify',
          admin_id: adminId,
          ...errorProperties(error),
        })
      }
    }

    if (deps.adminTelegramIds.length === 0) {
      deps.log.info({userId: input.userId}, 'Feature request submitted; no ADMIN_TELEGRAM_IDS set')
    }

    return {fundStatus, amountPaidSats, adminNotified}
  }

  return {submit}
}

export type FeatureRequestService = ReturnType<typeof createFeatureRequestService>

/** Short English HTML header before the copied user message. */
export function formatFeatureRequestAdminMeta(input: {
  userId: number
  username: string | null
  firstName: string | null
  amountPaidSats: number
  fundStatus: FeatureFundStatus
}): string {
  const who =
    input.username != null && input.username.length > 0
      ? `@${escapeHtml(input.username)}`
      : escapeHtml(input.firstName ?? 'User')
  const fundLine =
    input.fundStatus === 'paid'
      ? `💰 Funded: <b>${input.amountPaidSats}</b> sats`
      : input.fundStatus === 'pay_failed'
        ? '💰 Fund: attempted, payment failed (request still free)'
        : '💰 Fund: none'

  return [
    '💡 <b>New feature request</b>',
    `From: ${who} (<code>${input.userId}</code>)`,
    fundLine,
  ].join('\n')
}
