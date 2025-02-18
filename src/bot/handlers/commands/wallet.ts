import type {BotContext} from '../../context.js'
import {replyWithWallet} from '../../helpers/messages/wallet.js'

export function walletCommand(ctx: BotContext) {
  return replyWithWallet(ctx)
}
