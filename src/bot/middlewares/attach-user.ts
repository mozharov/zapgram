import {FromBotError} from '@core/errors/from-bot.js'
import type {Middleware} from 'grammy'
import type {User} from '../../lib/database/types.js'
import {NostrWallet} from '../../lib/nostr-wallet.js'
import {getOrCreateUser} from '../../models/user.js'
import type {BotContext} from '../context.js'

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
