import {FromBotError} from '@core/errors/from-bot.js'
import {normalizeTelegramLanguageCode} from '@core/i18n/locale.js'
import type {User} from '@infra/db/types.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {getOrCreateUser} from '@modules/users/repository.js'
import type {BotContext} from '@telegram/context.js'
import {isIdentifiableHumanSender} from '@telegram/helpers/identifiable-sender.js'
import type {Middleware} from 'grammy'
import {getRuntime} from '../../runtime.js'

/**
 * Load/refresh the DB user on private (and other) paths that need `ctx.user`.
 *
 * In private chats, any message/command/callback clears `bot_blocked` so broadcasts resume
 * after the user opens the bot again (join-request-only users often never /start but can still
 * press invoice buttons or open the wallet). `my_chat_member` block/unblock is left to
 * {@link privateMyChatMemberHandler} so attachUser does not fight a block event.
 *
 * Money paths must never debit a bot, channel, or anonymous-admin identity: Bot API does not
 * expose the real human behind `sender_chat`, so those updates raise {@link FromBotError}.
 */
export const attachUser: Middleware<Context> = async (ctx, next) => {
  if (!ctx.from) return next()
  if (!isIdentifiableHumanSender(ctx)) throw new FromBotError()

  const {config, log, users} = getRuntime()
  let user = await getOrCreateUser({
    id: ctx.from.id,
    username: ctx.from.username,
    languageCode: normalizeTelegramLanguageCode(ctx.from.language_code),
    firstName: ctx.from.first_name,
  })

  if (ctx.chat?.type === 'private' && user.botBlocked && !ctx.myChatMember) {
    user = await users.setBotBlocked(user.id, false)
    log.info({userId: user.id}, 'Cleared botBlocked after private interaction')
  }

  ctx.user = user
  if (ctx.user.nwcUrl) {
    ctx.user.nwc = new NostrWallet(ctx.user.nwcUrl, config.memoFooter, log)
  }

  return next()
}

type Context = Omit<BotContext, 'user'> & {user: User & {nwc?: NostrWallet}}
