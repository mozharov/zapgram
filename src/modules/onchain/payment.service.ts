import {buildSatsPayWebhookUrl} from '@core/lnbits/satspay-webhook-url.js'
import type {Chat, OnchainChatPayment} from '@infra/db/types.js'
import type {SatsPayClient} from '@infra/lnbits/satspay.js'
import type {AppLogger} from '@infra/logger.js'
import type {OnchainPaymentRepository} from './repository.js'

/** UI shows 24h; SatsPay `time` is minutes. */
export const ONCHAIN_UI_TTL_MS = 24 * 60 * 60 * 1000
/** Backend watches another 24h after UI expiry for late confirms. */
export const ONCHAIN_WATCH_GRACE_MS = 24 * 60 * 60 * 1000
export const ONCHAIN_CHARGE_TIME_MINUTES = 48 * 60 // cover UI + grace

export type CreateOnchainJoinPaymentInput = {
  chat: Pick<Chat, 'id' | 'price' | 'title' | 'watchonlyWalletId' | 'onchainEnabled'>
  userId: number
  description?: string
}

export type CreateOnchainJoinPaymentResult =
  | {status: 'created'; payment: OnchainChatPayment; address: string; amountSats: number}
  | {status: 'reused'; payment: OnchainChatPayment}
  | {status: 'disabled'}
  | {status: 'missing_wallet'}

export type OnchainJoinPaymentServiceDeps = {
  onchainPayments: OnchainPaymentRepository
  satsPay: Pick<SatsPayClient, 'createCharge'>
  host: string
  webhookSecret: string
  log: AppLogger
  now?: () => Date
}

export function createOnchainJoinPaymentService(deps: OnchainJoinPaymentServiceDeps) {
  const now = deps.now ?? (() => new Date())

  return {
    async createOrReuse(
      input: CreateOnchainJoinPaymentInput,
    ): Promise<CreateOnchainJoinPaymentResult> {
      if (!input.chat.onchainEnabled) return {status: 'disabled'}
      if (!input.chat.watchonlyWalletId) return {status: 'missing_wallet'}

      const existing = await deps.onchainPayments.findOpenForUserChat(input.userId, input.chat.id)
      if (existing && existing.expiresAt.getTime() > now().getTime()) {
        return {status: 'reused', payment: existing}
      }

      const createdAt = now()
      const expiresAt = new Date(createdAt.getTime() + ONCHAIN_UI_TTL_MS)
      const watchUntil = new Date(expiresAt.getTime() + ONCHAIN_WATCH_GRACE_MS)
      const webhook = buildSatsPayWebhookUrl(deps.host, deps.webhookSecret)

      // zeroconf: SatsPay treats mempool (unconfirmed) balance as paid — built into the extension.
      const charge = await deps.satsPay.createCharge({
        onchainwallet: input.chat.watchonlyWalletId,
        amount: input.chat.price,
        time: ONCHAIN_CHARGE_TIME_MINUTES,
        description: input.description ?? `ZapGram access: ${input.chat.title}`.slice(0, 200),
        webhook,
        name: `chat:${input.chat.id}:user:${input.userId}`,
        zeroconf: true,
      })

      if (!charge.onchainaddress) {
        deps.log.error({chargeId: charge.id}, 'SatsPay charge missing onchainaddress')
        throw new Error('SatsPay charge missing onchainaddress')
      }

      const payment = await deps.onchainPayments.create({
        chatId: input.chat.id,
        userId: input.userId,
        satspayChargeId: charge.id,
        address: charge.onchainaddress,
        amountSats: charge.amount,
        status: 'pending',
        expiresAt,
        watchUntil,
      })

      return {
        status: 'created',
        payment,
        address: charge.onchainaddress,
        amountSats: charge.amount,
      }
    },
  }
}

export type OnchainJoinPaymentService = ReturnType<typeof createOnchainJoinPaymentService>
