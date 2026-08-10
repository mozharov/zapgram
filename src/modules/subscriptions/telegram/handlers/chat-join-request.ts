import type {Chat} from '@infra/db/types.js'
import {getChat} from '@modules/chats/repository.js'
import {chatAllowsOnchain} from '@modules/onchain/complete.service.js'
import {getSubscriptionByUserAndChat} from '@modules/subscriptions/repository.js'
import {getJoinBalanceAvailability} from '@modules/subscriptions/telegram/join-balance.js'
import {buildJoinMethodKeyboard} from '@modules/subscriptions/telegram/keyboards/subscription-payment.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {usdSuffixForSats} from '@telegram/helpers/usd-suffix.js'
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
  return replyWithJoinMethodChooser(ctx, chat)
}

/**
 * First message on join: method chooser only — no LN invoice mint and no on-chain charge.
 * Invoice/address appear after the member taps Lightning or Bitcoin (edit in place).
 */
async function replyWithJoinMethodChooser(ctx: Context, chat: Chat) {
  const {posthog} = getRuntime()
  const showOnchain = chatAllowsOnchain(chat)
  // NWC failures must not block the chooser — getJoinBalanceAvailability swallows them.
  const balanceAvailability = await getJoinBalanceAvailability(ctx, chat.price)

  const keyboard = buildJoinMethodKeyboard(ctx.t, {
    chatId: chat.id,
    showOnchain,
    balanceAvailability,
  })

  const locale = await ctx.i18n.getLocale()
  const message = locale === 'ru' ? chat.customMessageRu : chat.customMessageEn
  // user_chat_id is the private-chat peer for the join-request contact window; from.id is only a user id.
  try {
    await ctx.api.sendMessage(
      ctx.chatJoinRequest.user_chat_id,
      ctx.t('subscription-invoice.choose-method', {
        message: message ?? ctx.t('subscription-invoice.default-message', {title: chat.title}),
        type: chat.paymentType,
        price: chat.price,
        usdSuffix: await usdSuffixForSats(chat.price),
      }),
      {reply_markup: keyboard, link_preview_options: {is_disabled: true}},
    )
  } catch (error: unknown) {
    ctx.log.error({error}, 'Error while sending message to user about chat join request')
    return
  }

  captureBotEvent(
    posthog,
    'subscription_join_method_chooser_sent',
    {
      chat_title: chat.title,
      chat_type: chat.type,
      payment_type: chat.paymentType,
      price_sats: chat.price,
      onchain_offered: showOnchain,
      wallet_covers: balanceAvailability.walletCovers,
      nwc_covers: balanceAvailability.nwcCovers,
    },
    {chatId: chat.id},
  )
}
