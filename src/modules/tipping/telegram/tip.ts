import {NoRecipientError} from '@core/errors/no-recipient.js'
import {ToBotError} from '@core/errors/to-bot.js'
import {ToYourselfError} from '@core/errors/to-yourself.js'
import {UserDoesNotHaveWalletError} from '@core/errors/user-does-not-have-wallet.js'
import type {HearsContext} from '@grammyjs/conversations/out/deps.node.js'
import type {User} from '@infra/db/types.js'
import {notifySatsReceived} from '@modules/tipping/notify-sats-received.js'
import {internalTransfer} from '@modules/tipping/transfer.service.js'
import {getOrCreateUser, getUserByUsername} from '@modules/users/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {getUserFromChatCreator} from '@telegram/helpers/chat-creator.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {replyWithTempMessage} from '@telegram/helpers/temp-message.js'
import type {ChatTypeContext} from 'grammy'
import {getRuntime} from '../../../runtime.js'

type Context = ChatTypeContext<HearsContext<BotContext>, 'group' | 'supergroup'>

export const tipInvalidCommand = async (ctx: Context) => {
  await deleteMessageSafely(ctx)
  return replyWithTempMessage(ctx, ctx.t('tip.invalid-command'))
}

export const tipCommand = async (ctx: Context) => {
  const {sats, username} = parseMatch(ctx.match)
  await deleteMessageSafely(ctx)
  if (sats === 0) return
  await ctx.replyWithChatAction('typing').catch(() => null)

  const toUser = await getToUser(ctx, username)
  if (!toUser) throw new NoRecipientError()
  if (toUser.id === ctx.user.id) throw new ToYourselfError()

  const usedNwc = Boolean(ctx.user.nwcTips && ctx.user.nwc)
  if (usedNwc && ctx.user.nwc) {
    const toUserWallet = await getUserWallet(toUser.id)
    const invoice = await toUserWallet.createInvoice({sats})
    await ctx.user.nwc.payInvoice(invoice.bolt11)
  } else await internalTransfer(ctx.user.id, toUser.id, sats)

  const replyTo = ctx.message.reply_to_message
  const toChatCreator = (!username && !replyTo) || !!replyTo?.sender_chat
  const toMessageId = replyTo?.message_id

  captureBotEvent(
    getRuntime().posthog,
    'tip_sent',
    {
      amount_sats: sats,
      payment_method: usedNwc ? 'nwc' : 'internal',
      recipient_id: toUser.id,
      recipient_username: toUser.username ?? null,
      to_chat_creator: toChatCreator,
      has_reply: Boolean(toMessageId),
    },
    {chatId: ctx.chat.id},
  )

  // Best-effort voluntary platform donation — after main pay; failures only notify in PM.
  await getRuntime().donationCollect.tryCollect({
    userId: ctx.user.id,
    baseAmountSats: sats,
    kind: 'tip',
    preferredRail: usedNwc ? 'nwc' : 'internal',
    nwc: usedNwc ? ctx.user.nwc : undefined,
    nwcUrl: ctx.user.nwcUrl,
    user: ctx.user,
  })

  await notifyGroupTip(ctx, toUser, sats, toMessageId, toChatCreator)
  await notifySatsReceived(toUser.id, sats, ctx.from.username)
}

function parseMatch(match: string | RegExpMatchArray): {
  sats: number
  username: string | undefined
} {
  const [, amount, username] = match
  const sats = amount ? Number(amount) : 21
  return {sats, username: username?.toLowerCase()}
}

async function getToUser(ctx: Context, username?: string) {
  if (username) {
    const user = await getUserByUsername(username)
    if (!user) throw new UserDoesNotHaveWalletError()
    return user
  }
  if (ctx.message.reply_to_message) {
    const {reply_to_message} = ctx.message
    const {from, sender_chat} = reply_to_message
    if (sender_chat) {
      const user = await getUserFromChatCreator(ctx, sender_chat.id)
      if (!user) throw new UserDoesNotHaveWalletError()
      return user
    }
    if (from) {
      const {id, username, is_bot, language_code} = from
      if (is_bot || id === 777000) throw new ToBotError() // Telegram service or bot
      return getOrCreateUser({id, username, languageCode: language_code})
    }
  }
  return getUserFromChatCreator(ctx)
}

export async function notifyGroupTip(
  ctx: Context,
  toUser: User,
  sats: number,
  toMessageId?: number,
  toChatCreator?: boolean,
) {
  const recipient = toUser.username ? `@${toUser.username}` : toUser.firstName || 'no'
  const sender = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name
  const reply_parameters = toMessageId ? {message_id: toMessageId} : undefined

  if (toChatCreator) {
    if (reply_parameters) {
      return ctx.reply(ctx.t('tip.to-author-of-the-message', {sender, sats}), {reply_parameters})
    }
    return ctx.reply(ctx.t('tip.to-chat-owner', {sender, sats}))
  }
  return ctx.reply(ctx.t('tip.to-user', {sender, sats, recipient}), {reply_parameters})
}
