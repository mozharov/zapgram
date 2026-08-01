import {updateUser} from '@modules/users/repository.js'
import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'

export const disconnectNwcCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await updateUser(ctx.user.id, {nwcUrl: null, nwcTips: false})
  await ctx.reply(ctx.t('nwc.disconnected'))
  return replyWithWallet(ctx)
}
