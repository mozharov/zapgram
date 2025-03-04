import {logger} from '../../../lib/logger.js'
import {msatsToSats} from '../../../lib/utils/sats.js'
import type {BotContext} from '../../context.js'
import {buildWalletKeyboard} from '../keyboards/wallet.js'

export async function replyWithWallet(ctx: BotContext) {
  const nwcBalance = await getNWCBalance(ctx)
  const balance = ctx.user.wallet.balance
  return ctx.reply(buildWalletText(ctx.t, balance, nwcBalance), {
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
      logger.error({error}, 'Failed to get NWC balance')
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
