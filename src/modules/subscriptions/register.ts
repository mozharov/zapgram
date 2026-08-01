import type {BotContext} from '@telegram/context.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import type {Composer} from 'grammy'
import {chatJoinRequestHandler} from './telegram/handlers/chat-join-request.js'
import {paySubscriptionCallback} from './telegram/handlers/pay-subscription.js'
import {subscriptionCallback} from './telegram/handlers/subscription-callback.js'
import {subscriptionsCallback} from './telegram/handlers/subscriptions-callback.js'
import {subscriptionsCommand} from './telegram/handlers/subscriptions-command.js'
import {toggleAutoRenewCallback} from './telegram/handlers/toggle-auto-renew.js'

export function register(composer: Composer<BotContext>): void {
  const paidChat = composer.chatType(['supergroup', 'channel'])
  paidChat.on('chat_join_request', attachUser, lnbitsWallet, chatJoinRequestHandler)

  const privateChat = composer.chatType('private')
  privateChat.command('subscriptions', subscriptionsCommand)
  privateChat.callbackQuery(/^subscriptions:(\d+)$/, subscriptionsCallback)
  privateChat.callbackQuery(/^subscription:([a-f0-9-]+)$/, subscriptionCallback)
  privateChat.callbackQuery(/^subscription:([a-f0-9-]+):renew$/, toggleAutoRenewCallback)
  privateChat.callbackQuery(/^pay-sub:([a-f0-9-]+):(wallet|nwc)$/, paySubscriptionCallback)
}
