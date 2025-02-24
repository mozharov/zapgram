import {Bot} from 'grammy'
import {config} from '../config.js'
import {BotContext} from './context.js'
import {logger} from './middlewares/logger.js'
import {autoRetry} from '@grammyjs/auto-retry'
import {parseMode} from '@grammyjs/parse-mode'
import {errorHandler} from './handlers/error.js'
import {i18n} from './middlewares/i18n.js'
import {startCommand} from './handlers/commands/start.js'
import {helpCommand} from './handlers/commands/help.js'
import {helpCallback} from './handlers/callbacks/help.js'
import {unknownCallback} from './handlers/callbacks/unknown.js'
import {walletCommand} from './handlers/commands/wallet.js'
import {attachUser} from './middlewares/attach-user.js'
import {walletCallback} from './handlers/callbacks/wallet.js'
import {conversations} from './middlewares/conversations.js'
import {createConversation} from '@grammyjs/conversations'
import {connectingNWC} from './conversations/connecting-nwc.js'
import {settingsCallback} from './handlers/callbacks/settings.js'
import {settingsCommand} from './handlers/commands/settings.js'
import {disconnectNwcCallback} from './handlers/callbacks/disconnect-nwc.js'
import {connectNwcCallback} from './handlers/callbacks/connect-nwc.js'
import {replyWithWallet} from './helpers/messages/wallet.js'
import {groupSettingsCallback} from './handlers/callbacks/group-settings.js'
import {nwcTipsCallback} from './handlers/callbacks/nwc-tips.js'
import {sendMenuCallback} from './handlers/callbacks/send-menu.js'
import {sendingToUser} from './conversations/sending-to-user.js'
import {sendToUserCallback} from './handlers/callbacks/send-to-user.js'
import {payingInvoice} from './conversations/paying-invoice.js'
import {payInvoiceCallback} from './handlers/callbacks/pay-invoice.js'
import {lnInvoiceHears} from './handlers/hears/ln-invoice.js'
import {lnbitsWallet} from './middlewares/lnbits-wallet.js'
import {creatingInvoice} from './conversations/creating-invoice.js'
import {createInvoiceCallback} from './handlers/callbacks/create-invoice.js'
import {tipCommand, tipInvalidCommand} from './handlers/commands/tip.js'
import {myChatMemberHandler} from './handlers/my-chat-member.js'
import {newChatTitleHandler} from './handlers/new-chat-title.js'
import {chatJoinRequestHandler} from './handlers/chat-join-request.js'
import {chatsCommand} from './handlers/commands/chats.js'
import {chatsCallback} from './handlers/callbacks/chats.js'
import {chatCallback} from './handlers/callbacks/chat.js'

export const bot = new Bot<BotContext>(config.BOT_TOKEN, {botInfo: config.botInfo})
bot.api.config.use(autoRetry())
bot.api.config.use(parseMode('HTML'))

const composer = bot.errorBoundary(errorHandler)
composer.use(conversations)
composer.use(logger)
composer.use(i18n)

composer
  .chatType(['supergroup', 'channel'])
  .on('my_chat_member', myChatMemberHandler)
  .on(':new_chat_title', newChatTitleHandler)
  .on('chat_join_request', chatJoinRequestHandler)

const privateChat = composer.chatType('private')
privateChat.use(attachUser)
privateChat.use(lnbitsWallet)
privateChat.use(createConversation(connectingNWC))
privateChat.use(createConversation(sendingToUser))
privateChat.use(createConversation(payingInvoice))
privateChat.use(createConversation(creatingInvoice))
privateChat.command('start', startCommand)
privateChat.command('help', helpCommand)
privateChat.command('wallet', walletCommand)
privateChat.command('settings', settingsCommand)
privateChat.command('chats', chatsCommand)
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
privateChat.callbackQuery(/^chat:(-?\d+)$/, chatCallback)
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
