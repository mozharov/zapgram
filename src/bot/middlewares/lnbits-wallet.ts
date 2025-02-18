import type {Middleware} from 'grammy'
import type {BotContext} from '../context.js'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'

export const lnbitsWallet: Middleware<BotContext> = async (ctx, next) => {
  ctx.user.wallet = await getUserWallet(ctx.user.id)
  return next()
}
