import {msatsToSats} from '@core/money/sats.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'
import {buildWalletKeyboard} from '../keyboards/wallet.js'

export async function replyWithWallet(ctx: BotContext) {
  const nwcBalance = await getNWCBalance(ctx)
  const balance = await ctx.user.wallet.getBalance()
  return ctx.reply(buildWalletText(ctx.t, balance, nwcBalance), {
    reply_markup: buildWalletKeyboard(ctx.t),
  })
}

/**
 * Renders from `ctx.user.wallet.balance` already loaded by `lnbitsWallet` middleware.
 * Used by the error handler so a failed live balance read is not immediately repeated.
 * No-ops when the middleware never attached a wallet (failure was earlier in the chain).
 */
export async function replyWithCachedWallet(ctx: BotContext) {
  const wallet = ctx.user?.wallet
  if (!wallet) return
  const nwcBalance = await getNWCBalance(ctx)
  return ctx.reply(buildWalletText(ctx.t, wallet.balance, nwcBalance), {
    reply_markup: buildWalletKeyboard(ctx.t),
  })
}

export async function editMessageWithWallet(ctx: BotContext) {
  const nwcBalance = await getNWCBalance(ctx)
  const balance = ctx.user.wallet.balance
  return ctx.editMessageText(buildWalletText(ctx.t, balance, nwcBalance), {
    reply_markup: buildWalletKeyboard(ctx.t),
  })
}

async function getNWCBalance(ctx: BotContext) {
  if (ctx.user.nwc) {
    return ctx.user.nwc.getBalance().catch(async (error: unknown) => {
      getRuntime().log.error({error}, 'Failed to get NWC balance')
      await ctx.reply(ctx.t('error.nwc-connection'))
      return null
    })
  }
  return null
}

function buildWalletText(t: BotContext['t'], balance: number, nwcBalance: number | null) {
  return t('wallet', {
    balance: msatsToSats(balance),
    nwcBalance: nwcBalance === null ? 'no' : msatsToSats(nwcBalance),
  })
}
