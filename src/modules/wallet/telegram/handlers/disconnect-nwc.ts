import {updateUser} from '@modules/users/repository.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'

export const disconnectNwcCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await updateUser(ctx.user.id, {nwcUrl: null, nwcTips: false})
  // attachUser built nwc from the still-connected row; clear it so this request's wallet
  // reply matches the DB instead of still listing an NWC balance.
  ctx.user.nwcUrl = null
  ctx.user.nwcTips = false
  ctx.user.nwc = undefined
  await ctx.reply(ctx.t('nwc.disconnected'))
  return replyWithWallet(ctx)
}
