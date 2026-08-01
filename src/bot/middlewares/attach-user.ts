import {FromBotError} from '@core/errors/from-bot.js'
import type {User} from '@infra/db/types.js'
import {NostrWallet} from '@infra/nostr/wallet.js'
import {getOrCreateUser} from '@modules/users/repository.js'
import type {BotContext} from '@telegram/context.js'
import type {Middleware} from 'grammy'

export const attachUser: Middleware<Context> = async (ctx, next) => {
  if (!ctx.from) return next()
  if (ctx.from.is_bot) throw new FromBotError()
  ctx.user = await getOrCreateUser({
    id: ctx.from.id,
    username: ctx.from.username,
    languageCode: ctx.from.language_code,
    firstName: ctx.from.first_name,
  })
  if (ctx.user.nwcUrl) ctx.user.nwc = new NostrWallet(ctx.user.nwcUrl)
  return next()
}

type Context = Omit<BotContext, 'user'> & {user: User & {nwc?: NostrWallet}}
