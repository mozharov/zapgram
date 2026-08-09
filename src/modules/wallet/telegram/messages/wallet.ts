import {msatsToSats} from '@core/money/sats.js'
import type {BotContext} from '@telegram/context.js'
import {usdSuffixForSats, usdSuffixesForSats} from '@telegram/helpers/usd-suffix.js'
import {getRuntime} from '../../../../runtime.js'
import {buildWalletKeyboard} from '../keyboards/wallet.js'

export async function replyWithWallet(ctx: BotContext) {
  const nwcBalance = await getNWCBalance(ctx)
  const balance = await ctx.user.wallet.getBalance()
  return ctx.reply(await buildWalletText(ctx.t, balance, nwcBalance), {
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
  return ctx.reply(await buildWalletText(ctx.t, wallet.balance, nwcBalance), {
    reply_markup: buildWalletKeyboard(ctx.t),
  })
}

export async function editMessageWithWallet(ctx: BotContext) {
  const nwcBalance = await getNWCBalance(ctx)
  const balance = ctx.user.wallet.balance
  return ctx.editMessageText(await buildWalletText(ctx.t, balance, nwcBalance), {
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

async function buildWalletText(t: BotContext['t'], balance: number, nwcBalance: number | null) {
  const balanceSats = msatsToSats(balance)
  if (nwcBalance === null) {
    return t('wallet', {
      balance: balanceSats,
      nwcBalance: 'no',
      usdSuffix: await usdSuffixForSats(balanceSats),
      nwcUsdSuffix: '',
    })
  }
  const nwcSats = msatsToSats(nwcBalance)
  const [usdSuffix = '', nwcUsdSuffix = ''] = await usdSuffixesForSats([balanceSats, nwcSats])
  return t('wallet', {
    balance: balanceSats,
    nwcBalance: nwcSats,
    usdSuffix,
    nwcUsdSuffix,
  })
}
