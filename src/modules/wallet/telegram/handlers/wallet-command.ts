import {replyWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'

export function walletCommand(ctx: BotContext) {
  return replyWithWallet(ctx)
}
