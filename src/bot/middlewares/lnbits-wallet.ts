import type {Middleware} from 'grammy'
import {getUserWallet} from '../../services/lnbits-user-wallet.js'
import type {BotContext} from '../context.js'

export const lnbitsWallet: Middleware<BotContext> = async (ctx, next) => {
  ctx.user.wallet = await getUserWallet(ctx.user.id)
  return next()
}
