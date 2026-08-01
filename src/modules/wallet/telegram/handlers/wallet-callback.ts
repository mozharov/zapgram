import {editMessageWithWallet} from '@modules/wallet/telegram/messages/wallet.js'
import type {BotContext} from '@telegram/context.js'

export function walletCallback(ctx: BotContext) {
  return editMessageWithWallet(ctx)
}
