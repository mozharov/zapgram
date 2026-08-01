import type {BotContext} from '@telegram/context.js'
import {replyWithWallet} from '../../helpers/messages/wallet.js'

export async function startCommand(ctx: BotContext) {
  await ctx.reply(ctx.t('start'))
  await replyWithWallet(ctx)
}
