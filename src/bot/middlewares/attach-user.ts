import type {Middleware} from 'grammy'
import type {BotContext} from '../context.js'
import {getOrCreateUser} from '../../models/user.js'
import {NostrWallet} from '../../lib/nostr-wallet.js'
import type {User} from '../../lib/database/types.js'

export const attachUser: Middleware<Context> = async (ctx, next) => {
  if (!ctx.from) return next()
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
