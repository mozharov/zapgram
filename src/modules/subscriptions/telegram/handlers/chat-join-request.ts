import {satsToMsats} from '@core/money/sats.js'
import type {Chat} from '@infra/db/types.js'
import {getChat} from '@modules/chats/repository.js'
import {chatAllowsOnchain} from '@modules/onchain/complete.service.js'
import {getSubscriptionByUserAndChat} from '@modules/subscriptions/repository.js'
import {buildSubscriptionPaymentKeyboard} from '@modules/subscriptions/telegram/keyboards/subscription-payment.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import type {ChatTypeContext} from 'grammy'
import type {ChatJoinRequest} from 'grammy/types'
import {getRuntime} from '../../../../runtime.js'

type Context = ChatTypeContext<BotContext, 'supergroup' | 'channel'> & {
  chatJoinRequest: ChatJoinRequest
}

export const chatJoinRequestHandler = async (ctx: Context) => {
  const {chat: tgChat} = ctx.chatJoinRequest
  ctx.log.debug({tgChat, user: ctx.user})

  const chat = await getChat({id: tgChat.id})
  if (chat?.status !== 'active') return

  const {posthog} = getRuntime()

  const subscription = await getSubscriptionByUserAndChat(ctx.user.id, chat.id)
  if (subscription) {
    captureBotEvent(
      posthog,
      'chat_join_request_auto_approved',
      {
        chat_title: chat.title,
        chat_type: chat.type,
        payment_type: chat.paymentType,
        has_active_subscription: true,
      },
      {chatId: chat.id},
    )
    return ctx.approveChatJoinRequest(ctx.user.id)
  }
  captureBotEvent(
    posthog,
    'chat_join_request_received',
    {
      chat_title: chat.title,
      chat_type: chat.type,
      payment_type: chat.paymentType,
      price_sats: chat.price,
      has_active_subscription: false,
    },
    {chatId: chat.id},
  )
  return replyWithSubscriptionInvoice(ctx, chat)
}

async function replyWithSubscriptionInvoice(ctx: Context, chat: Chat) {
  const {joinInvoiceService, posthog} = getRuntime()
  const invoice = await joinInvoiceService.getOrCreate({
    chatId: chat.id,
    userId: ctx.user.id,
    kind: 'join',
    subscriptionType: chat.paymentType,
    price: chat.price,
  })
  if (!invoice) return

  // Compare in msats so half-satoshi rounding cannot show an unfundable pay button.
  const priceMsats = satsToMsats(chat.price)
  const keyboard = buildSubscriptionPaymentKeyboard(ctx.t, {
    payNWC: ((await ctx.user.nwc?.getBalance()) ?? 0) >= priceMsats,
    payWallet: ctx.user.wallet.balance >= priceMsats,
    paymentId: invoice.attempt.id,
    onchainChatId: chatAllowsOnchain(chat) ? chat.id : undefined,
  })

  const locale = await ctx.i18n.getLocale()
  const message = locale === 'ru' ? chat.customMessageRu : chat.customMessageEn
  const remainingHours = Math.floor(invoice.remainingMinutes / 60)
  const remainingMinutes = invoice.remainingMinutes % 60
  const remaining = ctx.t('subscription-invoice.remaining-time', {
    hours: remainingHours,
    minutes: remainingMinutes,
  })
  // user_chat_id is the private-chat peer for the join-request contact window; from.id is only a user id.
  try {
    await ctx.api.sendMessage(
      ctx.chatJoinRequest.user_chat_id,
      ctx.t('subscription-invoice.created', {
        message: message ?? ctx.t('subscription-invoice.default-message', {title: chat.title}),
        invoice: invoice.attempt.paymentRequest,
        type: chat.paymentType,
        price: chat.price,
        remaining,
      }),
      {reply_markup: keyboard, link_preview_options: {is_disabled: true}},
    )
  } catch (error: unknown) {
    ctx.log.error({error}, 'Error while sending message to user about chat join request')
    return
  }

  // Only after Telegram accepted the DM — mirrors subscription_renewal_reminder_sent.
  captureBotEvent(
    posthog,
    'subscription_join_invoice_sent',
    {
      chat_title: chat.title,
      chat_type: chat.type,
      payment_type: chat.paymentType,
      price_sats: chat.price,
      payment_id: invoice.attempt.id,
      kind: 'join',
      reused: invoice.reused,
      remaining_minutes: invoice.remainingMinutes,
    },
    {chatId: chat.id},
  )
}
