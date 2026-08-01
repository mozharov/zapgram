import type {BotContext} from '@telegram/context.js'
import {replyWithWallet} from '../../helpers/messages/wallet.js'

export function walletCommand(ctx: BotContext) {
  return replyWithWallet(ctx)
}
