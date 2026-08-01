import {createConversation} from '@grammyjs/conversations'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {connectingNWC} from './telegram/conversations/connecting-nwc.js'
import {connectNwcCallback} from './telegram/handlers/connect-nwc.js'
import {disconnectNwcCallback} from './telegram/handlers/disconnect-nwc.js'
import {groupSettingsCallback} from './telegram/handlers/group-settings-callback.js'
import {nwcTipsCallback} from './telegram/handlers/nwc-tips.js'
import {sendMenuCallback} from './telegram/handlers/send-menu.js'
import {settingsCallback} from './telegram/handlers/settings-callback.js'
import {settingsCommand} from './telegram/handlers/settings-command.js'
import {walletCallback} from './telegram/handlers/wallet-callback.js'
import {walletCommand} from './telegram/handlers/wallet-command.js'
import {replyWithWallet} from './telegram/messages/wallet.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  privateChat.use(createConversation(connectingNWC))
  privateChat.command('wallet', walletCommand)
  privateChat.command('settings', settingsCommand)
  privateChat.callbackQuery('wallet', walletCallback)
  privateChat.callbackQuery('settings', settingsCallback)
  privateChat.callbackQuery('group-settings', groupSettingsCallback)
  privateChat.callbackQuery('disconnect-nwc', disconnectNwcCallback)
  privateChat.callbackQuery('connect-nwc', connectNwcCallback)
  privateChat.callbackQuery('toggle-nwc-tips', nwcTipsCallback)
  privateChat.callbackQuery('cancel', replyWithWallet)
  privateChat.callbackQuery('send-menu', sendMenuCallback)
}
