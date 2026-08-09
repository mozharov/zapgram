import {satsToMsats} from '@core/money/sats.js'
import {getAccessibleChat} from '@modules/chats/repository.js'
import {chatAllowsOnchain} from '@modules/onchain/complete.service.js'
import {buildSubscriptionPaymentKeyboard} from '@modules/subscriptions/telegram/keyboards/subscription-payment.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {payLightningRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/** Restore Lightning join invoice on the same message (from on-chain view). */
export const payLightningCallback = async (
  ctx: CallbackQueryContext<BotContext>,
): Promise<void> => {
  const {chatId} = payLightningRoute.parse(ctx.match)
  const chat = await getAccessibleChat(chatId)
  if (chat?.status !== 'active') {
    await ctx.answerCallbackQuery({text: ctx.t('chat.not-found')})
    return
  }

  const sourceMessage = ctx.callbackQuery.message
  if (!sourceMessage || !('message_id' in sourceMessage)) {
    await ctx.answerCallbackQuery({text: ctx.t('subscription-invoice.expired')})
    return
  }

  const {joinInvoiceService, log} = getRuntime()
  const invoice = await joinInvoiceService.getOrCreate({
    chatId: chat.id,
    userId: ctx.user.id,
    kind: 'join',
    subscriptionType: chat.paymentType,
    price: chat.price,
  })
  if (!invoice) {
    await ctx.answerCallbackQuery({text: ctx.t('subscription-invoice.expired')})
    return
  }

  const priceMsats = satsToMsats(chat.price)
  const keyboard = buildSubscriptionPaymentKeyboard(ctx.t, {
    payNWC: ((await ctx.user.nwc?.getBalance()) ?? 0) >= priceMsats,
    payWallet: ctx.user.wallet.balance >= priceMsats,
    paymentId: invoice.attempt.id,
    onchainChatId: chatAllowsOnchain(chat) ? chat.id : undefined,
  })

  const locale = await ctx.i18n.getLocale()
  const customMessage = locale === 'ru' ? chat.customMessageRu : chat.customMessageEn
  const remainingHours = Math.floor(invoice.remainingMinutes / 60)
  const remainingMinutes = invoice.remainingMinutes % 60
  const remaining = ctx.t('subscription-invoice.remaining-time', {
    hours: remainingHours,
    minutes: remainingMinutes,
  })

  const text = ctx.t('subscription-invoice.created', {
    message: customMessage ?? ctx.t('subscription-invoice.default-message', {title: chat.title}),
    invoice: invoice.attempt.paymentRequest,
    type: chat.paymentType,
    price: chat.price,
    remaining,
  })

  try {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
      link_preview_options: {is_disabled: true},
    })
  } catch (error) {
    log.error({error, chatId}, 'Failed to edit Lightning join invoice message')
    await ctx.answerCallbackQuery({text: ctx.t('subscription-invoice.expired')})
    return
  }

  await ctx.answerCallbackQuery()
  captureBotEvent(
    getRuntime().posthog,
    'subscription_join_lightning_shown',
    {
      chat_title: chat.title,
      price_sats: chat.price,
      payment_id: invoice.attempt.id,
      reused: invoice.reused,
    },
    {chatId: chat.id},
  )
}
