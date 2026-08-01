import {createConversation} from '@grammyjs/conversations'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {changingPrice} from './telegram/conversations/changing-price.js'
import {editCustomMessage} from './telegram/conversations/edit-custom-message.js'
import {changePriceCallback} from './telegram/handlers/change-price.js'
import {chatCallback} from './telegram/handlers/chat-callback.js'
import {chatsCallback} from './telegram/handlers/chats-callback.js'
import {chatsCommand} from './telegram/handlers/chats-command.js'
import {customMessageCallback} from './telegram/handlers/custom-message.js'
import {editCustomMessageCallback} from './telegram/handlers/edit-custom-message.js'
import {myChatMemberHandler} from './telegram/handlers/my-chat-member.js'
import {newChatTitleHandler} from './telegram/handlers/new-chat-title.js'
import {removeCustomMessageCallback} from './telegram/handlers/remove-custom-message.js'
import {turnPaidAccessCallback} from './telegram/handlers/turn-paid-access.js'
import {turnPaymentTypeCallback} from './telegram/handlers/turn-payment-type.js'

export function register(composer: Composer<BotContext>): void {
  const paidChat = composer.chatType(['supergroup', 'channel'])
  paidChat.on('my_chat_member', myChatMemberHandler)
  paidChat.on(':new_chat_title', newChatTitleHandler)

  const privateChat = composer.chatType('private')
  privateChat.use(createConversation(changingPrice))
  privateChat.use(createConversation(editCustomMessage))
  privateChat.command('chats', chatsCommand)
  privateChat.callbackQuery(/^chats:(\d+)$/, chatsCallback)
  privateChat.callbackQuery(/^chat:(-?\d+)$/, chatCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):(on|off)-paid$/, turnPaidAccessCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):turn-(one_time|monthly)$/, turnPaymentTypeCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):change-price$/, changePriceCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):custom-message$/, customMessageCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):edit-custom-message$/, editCustomMessageCallback)
  privateChat.callbackQuery(/^chat:(-?\d+):remove-custom-message$/, removeCustomMessageCallback)
}
