import {createConversation} from '@grammyjs/conversations'
import type {BotContext} from '@telegram/context.js'
import type {Bot} from 'grammy'
import {changingPrice} from '../bot/conversations/changing-price.js'
import {connectingNWC} from '../bot/conversations/connecting-nwc.js'
import {creatingInvoice} from '../bot/conversations/creating-invoice.js'
import {editCustomMessage} from '../bot/conversations/edit-custom-message.js'
import {payingInvoice} from '../bot/conversations/paying-invoice.js'
import {sendingToUser} from '../bot/conversations/sending-to-user.js'
import {changePriceCallback} from '../bot/handlers/callbacks/change-price.js'
import {chatCallback} from '../bot/handlers/callbacks/chat.js'
import {chatsCallback} from '../bot/handlers/callbacks/chats.js'
import {connectNwcCallback} from '../bot/handlers/callbacks/connect-nwc.js'
import {createInvoiceCallback} from '../bot/handlers/callbacks/create-invoice.js'
import {customMessageCallback} from '../bot/handlers/callbacks/custom-message.js'
import {disconnectNwcCallback} from '../bot/handlers/callbacks/disconnect-nwc.js'
import {editCustomMessageCallback} from '../bot/handlers/callbacks/edit-custom-message.js'
import {groupSettingsCallback} from '../bot/handlers/callbacks/group-settings.js'
import {helpCallback} from '../bot/handlers/callbacks/help.js'
import {nwcTipsCallback} from '../bot/handlers/callbacks/nwc-tips.js'
import {payInvoiceCallback} from '../bot/handlers/callbacks/pay-invoice.js'
import {paySubscriptionCallback} from '../bot/handlers/callbacks/pay-subscription.js'
import {removeCustomMessageCallback} from '../bot/handlers/callbacks/remove-custom-message.js'
import {sendMenuCallback} from '../bot/handlers/callbacks/send-menu.js'
import {sendToUserCallback} from '../bot/handlers/callbacks/send-to-user.js'
import {settingsCallback} from '../bot/handlers/callbacks/settings.js'
import {subscriptionCallback} from '../bot/handlers/callbacks/subscription.js'
import {subscriptionsCallback} from '../bot/handlers/callbacks/subscriptions.js'
import {toggleAutoRenewCallback} from '../bot/handlers/callbacks/toggle-auto-renew.js'
import {turnPaidAccessCallback} from '../bot/handlers/callbacks/turn-paid-access.js'
import {turnPaymentTypeCallback} from '../bot/handlers/callbacks/turn-payment-type.js'
import {unknownCallback} from '../bot/handlers/callbacks/unknown.js'
import {walletCallback} from '../bot/handlers/callbacks/wallet.js'
import {chatJoinRequestHandler} from '../bot/handlers/chat-join-request.js'
import {chatsCommand} from '../bot/handlers/commands/chats.js'
import {helpCommand} from '../bot/handlers/commands/help.js'
import {settingsCommand} from '../bot/handlers/commands/settings.js'
import {startCommand} from '../bot/handlers/commands/start.js'
import {subscriptionsCommand} from '../bot/handlers/commands/subscriptions.js'
import {tipCommand, tipInvalidCommand} from '../bot/handlers/commands/tip.js'
import {walletCommand} from '../bot/handlers/commands/wallet.js'
import {errorHandler} from '../bot/handlers/error.js'
import {lnInvoiceHears} from '../bot/handlers/hears/ln-invoice.js'
import {myChatMemberHandler} from '../bot/handlers/my-chat-member.js'
import {newChatTitleHandler} from '../bot/handlers/new-chat-title.js'
import {replyWithWallet} from '../bot/helpers/messages/wallet.js'
import {attachUser} from '../bot/middlewares/attach-user.js'
import {conversations} from '../bot/middlewares/conversations.js'
import {i18n} from '../bot/middlewares/i18n.js'
import {lnbitsWallet} from '../bot/middlewares/lnbits-wallet.js'
import {logger} from '../bot/middlewares/logger.js'

/**
 * Registers all grammY middleware and handlers. Order is load-bearing:
 * errorBoundary → conversations → logger → i18n, then chatType branches;
 * unknownCallback before on('message').
 */
export function registerHandlers(bot: Bot<BotContext>): void {
  const composer = bot.errorBoundary(errorHandler)
  composer.use(conversations)
  composer.use(logger)
  composer.use(i18n)

  const paidChat = composer.chatType(['supergroup', 'channel'])
  paidChat.on('my_chat_member', myChatMemberHandler)
  paidChat.on(':new_chat_title', newChatTitleHandler)
  paidChat.on('chat_join_request', attachUser, lnbitsWallet, chatJoinRequestHandler)

  const privateChat = composer.chatType('private')
  privateChat.use(attachUser)
  privateChat.use(lnbitsWallet)
  privateChat.use(createConversation(connectingNWC))
  privateChat.use(createConversation(sendingToUser))
  privateChat.use(createConversation(payingInvoice))
  privateChat.use(createConversation(creatingInvoice))
  privateChat.use(createConversation(changingPrice))
  privateChat.use(createConversation(editCustomMessage))
  privateChat.command('start', startCommand)
  privateChat.command('help', helpCommand)
  privateChat.command('wallet', walletCommand)
  privateChat.command('settings', settingsCommand)
  privateChat.command('chats', chatsCommand)
  privateChat.command('subscriptions', subscriptionsCommand)
  privateChat.callbackQuery('help', helpCallback)
  privateChat.callbackQuery('wallet', walletCallback)
  privateChat.callbackQuery('settings', settingsCallback)
  privateChat.callbackQuery('group-settings', groupSettingsCallback)
  privateChat.callbackQuery('disconnect-nwc', disconnectNwcCallback)
  privateChat.callbackQuery('connect-nwc', connectNwcCallback)
  privateChat.callbackQuery('toggle-nwc-tips', nwcTipsCallback)
  privateChat.callbackQuery('cancel', replyWithWallet)
  privateChat.callbackQuery('send-menu', sendMenuCallback)
  privateChat.callbackQuery('send-to-user', sendToUserCallback)
  privateChat.callbackQuery('pay-invoice', payInvoiceCallback)
  privateChat.callbackQuery('create-invoice', createInvoiceCallback)
  privateChat.callbackQuery(/^chats:(\d+)$/, chatsCallback)
  privateChat.callbackQuery(/^subscriptions:(\d+)$/, subscriptionsCallback)
  privateChat.callbackQuery(/^subscription:([a-f0-9-]+)$/, subscriptionCallback)
  privateChat.callbackQuery(/^subscription:([a-f0-9-]+):renew$/, toggleAutoRenewCallback)
  privateChat.callbackQuery(/^chat:(-?\d+)$/, chatCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):(on|off)-paid$/, turnPaidAccessCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):turn-(one_time|monthly)$/, turnPaymentTypeCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):change-price$/, changePriceCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):custom-message$/, customMessageCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):edit-custom-message$/, editCustomMessageCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):remove-custom-message$/, removeCustomMessageCallback)
  privateChat.callbackQuery(/^pay-sub:([a-f0-9-]+):(wallet|nwc)$/, paySubscriptionCallback)
  privateChat.hears(/(lnbc[a-z0-9]+)/).use(lnInvoiceHears)
  privateChat.on('callback_query', unknownCallback)
  privateChat.on('message', walletCommand)

  const groupChat = composer.chatType(['group', 'supergroup'])
  groupChat
    .hears(/^(?:\/tip|@zap_gram_bot)(?: (\d+))?(?: @(\w+))?$/)
    .use(attachUser)
    .use(lnbitsWallet)
    .use(tipCommand)
  groupChat.hears(/^(?:\/tip|@zap_gram_bot)/).use(tipInvalidCommand)
}
