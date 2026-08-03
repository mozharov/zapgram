import {createConversation} from '@grammyjs/conversations'
import {staticCallback} from '@telegram/callback-data.js'
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

export const walletCommands = ['wallet', 'settings'] as const

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  privateChat.use(createConversation(connectingNWC))
  privateChat.command(walletCommands[0], walletCommand)
  privateChat.command(walletCommands[1], settingsCommand)
  privateChat.callbackQuery(staticCallback.wallet, walletCallback)
  privateChat.callbackQuery(staticCallback.settings, settingsCallback)
  privateChat.callbackQuery(staticCallback.groupSettings, groupSettingsCallback)
  privateChat.callbackQuery(staticCallback.disconnectNwc, disconnectNwcCallback)
  privateChat.callbackQuery(staticCallback.connectNwc, connectNwcCallback)
  privateChat.callbackQuery(staticCallback.toggleNwcTips, nwcTipsCallback)
  // `cancel` is deliberately NOT registered here: it must run after every module's
  // createConversation() so a conversation waiting for input can consume it first.
  // See the terminal section of telegram/composition.ts.
  privateChat.callbackQuery(staticCallback.sendMenu, sendMenuCallback)
}
