import {getAccessibleChat} from '@modules/chats/repository.js'
import {effectiveCustomMessage} from '@modules/chats/telegram/messages/custom-message.js'
import {chatAllowsOnchain} from '@modules/onchain/complete.service.js'
import {getJoinBalanceAvailability} from '@modules/subscriptions/telegram/join-balance.js'
import {buildSubscriptionPaymentKeyboard} from '@modules/subscriptions/telegram/keyboards/subscription-payment.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {payLightningRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/**
 * Show Lightning join invoice on the same message (from chooser or on-chain view).
 * Always edits — join-request DMs cannot always receive a new bot message.
 */
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

  const balanceAvailability = await getJoinBalanceAvailability(ctx, chat.price)
  const keyboard = buildSubscriptionPaymentKeyboard(ctx.t, {
    paymentId: invoice.attempt.id,
    onchainChatId: chatAllowsOnchain(chat) ? chat.id : undefined,
    balanceAvailability,
    chatIdForBalancePay: chat.id,
  })

  const locale = await ctx.i18n.getLocale()
  // Minted attempts always store the decoded expiry; the reuse path is the only one that could
  // hand back a row without it, and there the remaining minutes are exact enough.
  const expiresAt =
    invoice.attempt.expiresAt ?? new Date(Date.now() + invoice.remainingMinutes * 60_000)
  const remaining = ctx.t('subscription-invoice.remaining-time', {expiresAt})

  const text = ctx.t('subscription-invoice.created', {
    message: effectiveCustomMessage(chat, locale),
    invoice: invoice.attempt.paymentRequest,
    type: chat.paymentType,
    price: chat.price,
    usdSuffix: await usdSuffixForSats(chat.price),
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
