import {FromBotError} from '@core/errors/from-bot.js'
import {normalizeTelegramLanguageCode} from '@core/i18n/locale.js'
import type {User} from '@infra/db/types.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {getOrCreateUser} from '@modules/users/repository.js'
import type {BotContext} from '@telegram/context.js'
import type {Middleware} from 'grammy'
import {getRuntime} from '../../runtime.js'

export const attachUser: Middleware<Context> = async (ctx, next) => {
  if (!ctx.from) return next()
  if (ctx.from.is_bot) throw new FromBotError()
  ctx.user = await getOrCreateUser({
    id: ctx.from.id,
    username: ctx.from.username,
    languageCode: normalizeTelegramLanguageCode(ctx.from.language_code),
    firstName: ctx.from.first_name,
  })
  if (ctx.user.nwcUrl) {
    const {config, log} = getRuntime()
    ctx.user.nwc = new NostrWallet(ctx.user.nwcUrl, config.memoFooter, log)
  }
  return next()
}

type Context = Omit<BotContext, 'user'> & {user: User & {nwc?: NostrWallet}}
