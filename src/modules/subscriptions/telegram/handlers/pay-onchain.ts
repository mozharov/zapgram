import {getAccessibleChat} from '@modules/chats/repository.js'
import {chatAllowsOnchain} from '@modules/onchain/complete.service.js'
import {buildOnchainPaymentKeyboard} from '@modules/subscriptions/telegram/keyboards/subscription-payment.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {payOnchainRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
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

  // Join-request DMs often reach users who never pressed /start. New sendMessage
  // then 403s ("can't initiate conversation"); edit the message that already has
  // the callback button instead (same pattern as other invoice callbacks).
  const sourceMessage = ctx.callbackQuery.message
  if (!sourceMessage || !('message_id' in sourceMessage)) {
    await ctx.answerCallbackQuery({text: ctx.t('onchain-invoice.create-failed')})
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
  const remaining = ctx.t('subscription-invoice.remaining-time', {
    expiresAt: payment.expiresAt,
  })

  const text = ctx.t('onchain-invoice.created', {
    title: chat.title,
    address: payment.address,
    price: payment.amountSats,
    usdSuffix: await usdSuffixForSats(payment.amountSats),
    type: chat.paymentType,
    remaining,
  })

  try {
    await ctx.editMessageText(text, {
      link_preview_options: {is_disabled: true},
      reply_markup: buildOnchainPaymentKeyboard(ctx.t, chat.id),
    })
  } catch (error) {
    log.error({error, chatId, paymentId: payment.id}, 'Failed to edit on-chain payment message')
    await ctx.answerCallbackQuery({text: ctx.t('onchain-invoice.create-failed')})
    return
  }

  await onchainPayments.setTelegramMessage(
    payment.id,
    sourceMessage.chat.id,
    sourceMessage.message_id,
  )
  await ctx.answerCallbackQuery()

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
