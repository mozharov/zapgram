import type {BotContext} from '@telegram/context.js'
import {updateUser} from '../../../models/user.js'
import {replyWithWallet} from '../../helpers/messages/wallet.js'

export const disconnectNwcCallback = async (ctx: BotContext) => {
  await ctx.deleteMessage()
  await updateUser(ctx.user.id, {nwcUrl: null, nwcTips: false})
  await ctx.reply(ctx.t('nwc.disconnected'))
  return replyWithWallet(ctx)
}
