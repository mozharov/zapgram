import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {attachUser} from '@telegram/middlewares/attach-user.js'
import {lnbitsWallet} from '@telegram/middlewares/lnbits-wallet.js'
import type {Composer} from 'grammy'
import {sendToUserCallback} from './telegram/send-to-user-callback.js'
import {tipCommand, tipInvalidCommand} from './telegram/tip.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  // createConversation(sendingToUser) lives in telegram/composition.ts.
  privateChat.callbackQuery(staticCallback.sendToUser, sendToUserCallback)

  const groupChat = composer.chatType(['group', 'supergroup'])
  groupChat
    .hears(/^(?:\/tip|@zap_gram_bot)(?: (\d+))?(?: @(\w+))?$/)
    .use(attachUser)
    .use(lnbitsWallet)
    .use(tipCommand)
  groupChat.hears(/^(?:\/tip|@zap_gram_bot)/).use(tipInvalidCommand)
}
