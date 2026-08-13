import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {featureCallback} from './telegram/handlers/feature-callback.js'

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  privateChat.callbackQuery(staticCallback.featureRequest, featureCallback)
}
