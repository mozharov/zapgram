import {
  payJoinBalanceRoute,
  payLightningRoute,
  payOnchainRoute,
  paySubscriptionRoute,
  subscriptionRenewRoute,
  subscriptionRoute,
  subscriptionsPageRoute,
} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import type {Composer} from 'grammy'
import {chatJoinRequestHandler} from './telegram/handlers/chat-join-request.js'
import {payJoinBalanceCallback} from './telegram/handlers/pay-join-balance.js'
import {payLightningCallback} from './telegram/handlers/pay-lightning.js'
import {payOnchainCallback} from './telegram/handlers/pay-onchain.js'
import {paySubscriptionCallback} from './telegram/handlers/pay-subscription.js'
import {subscriptionCallback} from './telegram/handlers/subscription-callback.js'
import {subscriptionsCallback} from './telegram/handlers/subscriptions-callback.js'
import {subscriptionsCommand} from './telegram/handlers/subscriptions-command.js'
import {toggleAutoRenewCallback} from './telegram/handlers/toggle-auto-renew.js'

export const subscriptionsCommands = ['subscriptions'] as const

export function register(composer: Composer<BotContext>): void {
  const paidChat = composer.chatType(['supergroup', 'channel'])
  paidChat.on('chat_join_request', attachUser, lnbitsWallet, chatJoinRequestHandler)

  const privateChat = composer.chatType('private')
  privateChat.command(subscriptionsCommands[0], subscriptionsCommand)
  privateChat.callbackQuery(subscriptionsPageRoute.pattern, subscriptionsCallback)
  privateChat.callbackQuery(subscriptionRoute.pattern, subscriptionCallback)
  privateChat.callbackQuery(subscriptionRenewRoute.pattern, toggleAutoRenewCallback)
  privateChat.callbackQuery(paySubscriptionRoute.pattern, paySubscriptionCallback)
  privateChat.callbackQuery(payJoinBalanceRoute.pattern, payJoinBalanceCallback)
  privateChat.callbackQuery(payOnchainRoute.pattern, payOnchainCallback)
  privateChat.callbackQuery(payLightningRoute.pattern, payLightningCallback)
}
