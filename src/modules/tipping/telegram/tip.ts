import {attachErrorAnalytics} from '@core/errors/app-error.js'
import {NoRecipientError} from '@core/errors/no-recipient.js'
import {ToBotError} from '@core/errors/to-bot.js'
import {ToYourselfError} from '@core/errors/to-yourself.js'
import {UserDoesNotHaveWalletError} from '@core/errors/user-does-not-have-wallet.js'
import type {Filter} from '@grammyjs/conversations/out/deps.node.js'
import type {User} from '@infra/db/types.js'
import {notifySatsReceived} from '@modules/tipping/notify-sats-received.js'
import {matchTipRequest, type TipRequest} from '@modules/tipping/telegram/tip-match.js'
import {internalTransfer} from '@modules/tipping/transfer.service.js'
import {getOrCreateUser, getUserByUsername} from '@modules/users/repository.js'
import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import {captureBotEvent} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {getUserFromChatCreator} from '@telegram/helpers/chat-creator.js'
import {deleteMessageSafely} from '@telegram/helpers/delete-message.js'
import {replyOnlyToSender} from '@telegram/helpers/ephemeral-message.js'
import type {ChatTypeContext} from 'grammy'
import {getRuntime} from '../../../runtime.js'

type Context = ChatTypeContext<Filter<BotContext, ':text' | ':caption'>, 'group' | 'supergroup'>

/** The text the trigger was matched against — same source grammY's own `hears` reads. */
export function tipText(ctx: Filter<BotContext, ':text' | ':caption'>): string {
  return ctx.msg.text ?? ctx.msg.caption ?? ''
}

type ResolvedTipRecipient = {
  user: User
  /** Tip was addressed to this bot and routed to the first ADMIN_TELEGRAM_IDS wallet. */
  viaPlatformBot: boolean
  attemptedRecipientId?: number
  attemptedRecipientUsername?: string | null
}

export const tipInvalidCommand = async (ctx: Context) => {
  await deleteMessageSafely(ctx)
  return replyOnlyToSender(ctx, ctx.t('tip.invalid-command'))
}

export const tipCommand = async (ctx: Context) => {
  const {sats, username} = requestOf(ctx)
  await deleteMessageSafely(ctx)
  if (sats === 0) return
  await ctx.replyWithChatAction('typing').catch(() => null)

  let resolved: ResolvedTipRecipient
  try {
    const next = await getToUser(ctx, username)
    if (!next) throw new NoRecipientError()
    resolved = next
  } catch (error) {
    attachErrorAnalytics(error, tipAnalyticsBase(sats, username))
    throw error
  }

  const {user: toUser, viaPlatformBot} = resolved
  if (toUser.id === ctx.user.id) {
    const error = new ToYourselfError()
    attachErrorAnalytics(error, {
      ...tipAnalyticsBase(sats, username),
      ...recipientAnalytics(resolved),
    })
    throw error
  }

  try {
    const usedNwc = Boolean(ctx.user.nwcTips && ctx.user.nwc)
    if (usedNwc && ctx.user.nwc) {
      const toUserWallet = await getUserWallet(toUser.id)
      const invoice = await toUserWallet.createInvoice({sats})
      await ctx.user.nwc.payInvoice(invoice.bolt11)
    } else await internalTransfer(ctx.user.id, toUser.id, sats)

    ctx.log.info(
      {toUserId: toUser.id, sats, source: usedNwc ? 'nwc' : 'internal', viaPlatformBot},
      'Tip sent',
    )

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
        via_platform_bot: viaPlatformBot,
        ...(viaPlatformBot
          ? {
              attempted_recipient_id: resolved.attemptedRecipientId ?? ctx.me.id,
              attempted_recipient_username:
                resolved.attemptedRecipientUsername ?? ctx.me.username?.toLowerCase() ?? null,
            }
          : {}),
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

    // Group confirmation names the intended target (the bot), not the admin wallet.
    const publicRecipient = viaPlatformBot
      ? ({
          ...toUser,
          username: ctx.me.username?.toLowerCase(),
          firstName: ctx.me.first_name,
        } satisfies User)
      : toUser

    await notifyGroupTip(ctx, publicRecipient, sats, toMessageId, toChatCreator)
    await notifySatsReceived(toUser.id, sats, ctx.from.username)
  } catch (error) {
    attachErrorAnalytics(error, {
      ...tipAnalyticsBase(sats, username),
      ...recipientAnalytics(resolved),
    })
    throw error
  }
}

function tipAnalyticsBase(sats: number, username?: string) {
  return {
    amount_sats: sats,
    tip_username: username ?? null,
  }
}

function recipientAnalytics(resolved: ResolvedTipRecipient) {
  return {
    recipient_id: resolved.user.id,
    recipient_username: resolved.user.username ?? null,
    via_platform_bot: resolved.viaPlatformBot,
    ...(resolved.attemptedRecipientId !== undefined
      ? {attempted_recipient_id: resolved.attemptedRecipientId}
      : {}),
    ...(resolved.attemptedRecipientUsername !== undefined
      ? {attempted_recipient_username: resolved.attemptedRecipientUsername}
      : {}),
  }
}

/** The composer only routes accepted triggers here, so re-matching cannot come back empty. */
function requestOf(ctx: Context): TipRequest {
  const request = matchTipRequest(tipText(ctx), ctx.me.username)
  if (request === null || request === 'invalid') {
    throw new Error(`tipCommand received an unmatched trigger: ${request}`)
  }
  return request
}

async function getToUser(ctx: Context, username?: string): Promise<ResolvedTipRecipient | null> {
  if (username) {
    if (isOurBotUsername(ctx, username)) {
      return resolvePlatformBotTip({
        attemptedRecipientId: ctx.me.id,
        attemptedRecipientUsername: username,
      })
    }
    const user = await getUserByUsername(username)
    if (!user) throw new UserDoesNotHaveWalletError()
    return {user, viaPlatformBot: false}
  }
  if (ctx.message.reply_to_message) {
    const {reply_to_message} = ctx.message
    const {from, sender_chat} = reply_to_message
    if (sender_chat) {
      const user = await getUserFromChatCreator(ctx, sender_chat.id)
      if (!user) throw new UserDoesNotHaveWalletError()
      return {user, viaPlatformBot: false}
    }
    if (from) {
      const {id, username: fromUsername, is_bot, language_code} = from
      if (id === ctx.me.id) {
        return resolvePlatformBotTip({
          attemptedRecipientId: id,
          attemptedRecipientUsername: fromUsername?.toLowerCase() ?? null,
        })
      }
      if (is_bot || id === 777000) {
        // Other bots / Telegram service — not a tippable wallet.
        throw new ToBotError({
          analytics: {
            attempted_recipient_id: id,
            attempted_recipient_username: fromUsername?.toLowerCase() ?? null,
            attempted_is_bot: is_bot,
          },
        })
      }
      const user = await getOrCreateUser({id, username: fromUsername, languageCode: language_code})
      return {user, viaPlatformBot: false}
    }
  }
  const user = await getUserFromChatCreator(ctx)
  return user ? {user, viaPlatformBot: false} : null
}

/**
 * Tips addressed to this bot land on the first configured admin's ZapGram wallet.
 * No ADMIN_TELEGRAM_IDS → same refusal as tipping any other bot.
 */
async function resolvePlatformBotTip(attempted: {
  attemptedRecipientId: number
  attemptedRecipientUsername?: string | null
}): Promise<ResolvedTipRecipient> {
  const adminId = getRuntime().config.ADMIN_TELEGRAM_IDS[0]
  if (!adminId) {
    throw new ToBotError({
      analytics: {
        attempted_recipient_id: attempted.attemptedRecipientId,
        attempted_recipient_username: attempted.attemptedRecipientUsername ?? null,
        attempted_is_bot: true,
        via_platform_bot: false,
      },
    })
  }
  const user = await getOrCreateUser({id: adminId})
  return {
    user,
    viaPlatformBot: true,
    attemptedRecipientId: attempted.attemptedRecipientId,
    attemptedRecipientUsername: attempted.attemptedRecipientUsername ?? null,
  }
}

function isOurBotUsername(ctx: Context, username: string): boolean {
  const botUsername = ctx.me.username?.toLowerCase()
  return Boolean(botUsername && username === botUsername)
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
