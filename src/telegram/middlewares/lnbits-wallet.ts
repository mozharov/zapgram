import {getUserWallet} from '@modules/wallet/user-wallet.service.js'
import type {BotContext} from '@telegram/context.js'
import type {Middleware} from 'grammy'

export const lnbitsWallet: Middleware<BotContext> = async (ctx, next) => {
  ctx.user.wallet = await getUserWallet(ctx.user.id)
  return next()
}
