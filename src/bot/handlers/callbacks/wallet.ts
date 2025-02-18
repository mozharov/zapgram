import type {BotContext} from '../../context.js'
import {editMessageWithWallet} from '../../helpers/messages/wallet.js'

export function walletCallback(ctx: BotContext) {
  return editMessageWithWallet(ctx)
}
