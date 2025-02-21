import type {HearsContext} from '@grammyjs/conversations/out/deps.node.js'
import type {ChatTypeContext} from 'grammy'
import type {BotContext} from '../../context.js'
import {replyWithTempMessage} from '../../helpers/temp-message.js'
import {getOrCreateUser, getUserByUsername} from '../../../models/user.js'
import {getUserFromChatCreator} from '../../helpers/chat-creator.js'
import {NoRecipientError} from '../../errors/no-recipient.js'
import {ToBotError} from '../../errors/to-bot.js'
import {ToYourselfError} from '../../errors/to-yourselfs.js'
import {notifySatsReceived} from '../../../services/notify-sats-recceived.js'
import {UserDoesNotHaveWalletError} from '../../errors/user-does-not-have-wallet.js'
import type {User} from '../../../lib/database/types.js'
import {internalTransfer} from '../../../services/lnbits-user-wallet.js'
import {getUserWallet} from '../../../services/lnbits-user-wallet.js'

type Context = ChatTypeContext<HearsContext<BotContext>, 'group' | 'supergroup'>

export const tipInvalidCommand = async (ctx: Context) => {
  await ctx.deleteMessage()
  return replyWithTempMessage(ctx, ctx.t('tip.invalid-command'))
}

export const tipCommand = async (ctx: Context) => {
  const {sats, username} = parseMatch(ctx.match)
  await ctx.deleteMessage().catch(() => null)
  if (sats === 0) return
  await ctx.replyWithChatAction('typing').catch(() => null)

  const toUser = await getToUser(ctx, username)
  if (!toUser) throw new NoRecipientError()
  if (toUser.id === ctx.user.id) throw new ToYourselfError()

  if (ctx.user.nwcTips && ctx.user.nwc) {
    const toUserWallet = await getUserWallet(toUser.id)
    const invoice = await toUserWallet.createInvoice({sats})
    await ctx.user.nwc.payInvoice(invoice.bolt11)
  } else await internalTransfer(ctx.user.id, toUser.id, sats)

  const replyTo = ctx.message.reply_to_message
  const toChatCreator = (!username && !replyTo) || !!replyTo?.sender_chat
  const toMessageId = replyTo?.message_id

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
    if (sender_chat) return getUserFromChatCreator(ctx)
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
