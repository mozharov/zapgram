import {satsToMsats} from '@core/money/sats.js'
import type {Chat} from '@infra/db/types.js'
import {getChat} from '@modules/chats/repository.js'
import {getSubscriptionByUserAndChat} from '@modules/subscriptions/repository.js'
import {buildSubscriptionPaymentKeyboard} from '@modules/subscriptions/telegram/keyboards/subscription-payment.js'
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

  const subscription = await getSubscriptionByUserAndChat(ctx.user.id, chat.id)
  if (subscription) return ctx.approveChatJoinRequest(ctx.user.id)
  return replyWithSubscriptionInvoice(ctx, chat)
}

async function replyWithSubscriptionInvoice(ctx: BotContext, chat: Chat) {
  const invoice = await getRuntime().joinInvoiceService.getOrCreate({
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
  })

  const locale = await ctx.i18n.getLocale()
  const message = locale === 'ru' ? chat.customMessageRu : chat.customMessageEn
  const remainingHours = Math.floor(invoice.remainingMinutes / 60)
  const remainingMinutes = invoice.remainingMinutes % 60
  const remaining = ctx.t('subscription-invoice.remaining-time', {
    hours: remainingHours,
    minutes: remainingMinutes,
  })
  await ctx.api
    .sendMessage(
      ctx.user.id,
      ctx.t('subscription-invoice.created', {
        message: message ?? ctx.t('subscription-invoice.default-message', {title: chat.title}),
        invoice: invoice.attempt.paymentRequest,
        type: chat.paymentType,
        price: chat.price,
        remaining,
      }),
      {reply_markup: keyboard, link_preview_options: {is_disabled: true}},
    )
    .catch((error: unknown) => {
      ctx.log.error({error}, 'Error while sending message to user about chat join request')
    })
}
