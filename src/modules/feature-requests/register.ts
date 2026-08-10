import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {featureCommand} from './telegram/handlers/feature-command.js'

export const featureRequestCommands = ['feature'] as const

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  privateChat.command(featureRequestCommands[0], featureCommand)
}
