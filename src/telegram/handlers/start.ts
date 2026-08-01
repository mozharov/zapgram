import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'

export async function startCommand(ctx: BotContext) {
  await ctx.reply(ctx.t('start'))
  await replyWithWallet(ctx)
}
