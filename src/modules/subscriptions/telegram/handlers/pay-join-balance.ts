import {NWCConnectionError} from '@core/errors/nwc-connection.js'
import {satsToMsats} from '@core/money/sats.js'
import {getAccessibleChat} from '@modules/chats/repository.js'
import {getJoinBalanceAvailability} from '@modules/subscriptions/telegram/join-balance.js'
import {captureBotEvent} from '@telegram/analytics.js'
import {payJoinBalanceRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import type {CallbackQueryContext} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

/**
 * Chooser / Lightning view → pay from one balance rail without pasting a BOLT11.
 * Mints (or reuses) the join invoice, pays the chosen source, removes the message.
 */
export const payJoinBalanceCallback = async (
  ctx: CallbackQueryContext<BotContext>,
): Promise<void> => {
  const {chatId, from} = payJoinBalanceRoute.parse(ctx.match)
  const chat = await getAccessibleChat(chatId)
  if (chat?.status !== 'active') {
    await ctx.answerCallbackQuery({text: ctx.t('chat.not-found')})
    return
  }

  const availability = await getJoinBalanceAvailability(ctx, chat.price)
  const stillCovers = from === 'wallet' ? availability.walletCovers : availability.nwcCovers
  if (!stillCovers) {
    await ctx.answerCallbackQuery({text: ctx.t('subscription-invoice.insufficient-balance')})
    return
  }

  const {joinInvoiceService, posthog} = getRuntime()
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

  // Double-check live wallet funds (NWC may have changed between render and click).
  const priceMsats = satsToMsats(chat.price)
  if (from === 'wallet') {
    if (ctx.user.wallet.balance < priceMsats) {
      await ctx.answerCallbackQuery({text: ctx.t('subscription-invoice.insufficient-balance')})
      return
    }
    await ctx.user.wallet.payInvoice(invoice.attempt.paymentRequest)
  } else {
    if (!ctx.user.nwc) throw new NWCConnectionError()
    await ctx.user.nwc.payInvoice(invoice.attempt.paymentRequest)
  }

  ctx.log.info(
    {
      paymentId: invoice.attempt.id,
      paymentHash: invoice.attempt.paymentHash,
      sats: invoice.attempt.price,
      source: from,
      reusedInvoice: invoice.reused,
    },
    'Join invoice paid from balance',
  )

  captureBotEvent(
    posthog,
    'subscription_paid',
    {
      payment_method: from,
      amount_sats: invoice.attempt.price,
      chat_id: chat.id,
      payment_id: invoice.attempt.id,
      from_chooser: true,
    },
    {chatId: chat.id},
  )

  await deleteMessageSafely(ctx)
  await ctx.answerCallbackQuery()
  await ctx.reply(ctx.t('subscription-invoice.paid-from-balance'))
}
