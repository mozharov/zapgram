import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'

export async function openMenuCallback(ctx: BotContext) {
  await ctx.answerCallbackQuery()
  return replyWithWallet(ctx)
}
