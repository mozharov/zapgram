import {getAccessibleChat} from '@modules/chats/repository.js'
import {chatAllowsOnchain} from '@modules/onchain/complete.service.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {payOnchainRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const payOnchainCallback = async (ctx: CallbackQueryContext<BotContext>): Promise<void> => {
  const {chatId} = payOnchainRoute.parse(ctx.match)
  const chat = await getAccessibleChat(chatId)
  if (chat?.status !== 'active') {
    await ctx.answerCallbackQuery({text: ctx.t('chat.not-found')})
    return
  }
  if (!chatAllowsOnchain(chat)) {
    await ctx.answerCallbackQuery({text: ctx.t('onchain-invoice.disabled')})
    return
  }

  const {onchainJoinPaymentService, onchainPayments, posthog, log} = getRuntime()
  let result: Awaited<ReturnType<typeof onchainJoinPaymentService.createOrReuse>>
  try {
    result = await onchainJoinPaymentService.createOrReuse({
      chat,
      userId: ctx.user.id,
    })
  } catch (error) {
    log.error({error, chatId}, 'Failed to create on-chain join payment')
    await ctx.answerCallbackQuery({text: ctx.t('onchain-invoice.create-failed')})
    return
  }

  if (result.status === 'disabled' || result.status === 'missing_wallet') {
    await ctx.answerCallbackQuery({text: ctx.t('onchain-invoice.disabled')})
    return
  }

  const payment = result.payment
  const remainingMs = Math.max(0, payment.expiresAt.getTime() - Date.now())
  const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000))
  const remainingMinutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000))
  const remaining = ctx.t('subscription-invoice.remaining-time', {
    hours: remainingHours,
    minutes: remainingMinutes,
  })

  const text = ctx.t('onchain-invoice.created', {
    title: chat.title,
    address: payment.address,
    price: payment.amountSats,
    type: chat.paymentType,
    remaining,
  })

  await ctx.answerCallbackQuery()
  const sent = await ctx.reply(text, {link_preview_options: {is_disabled: true}})
  if (sent.chat && sent.message_id) {
    await onchainPayments.setTelegramMessage(payment.id, sent.chat.id, sent.message_id)
  }

  captureBotEvent(
    posthog,
    'subscription_join_onchain_invoice_sent',
    {
      chat_title: chat.title,
      price_sats: payment.amountSats,
      payment_id: payment.id,
      charge_id: payment.satspayChargeId,
      reused: result.status === 'reused',
    },
    {chatId: chat.id},
  )
}
