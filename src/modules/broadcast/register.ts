import {botCommand} from '@telegram/bot-commands.js'
import type {BotContext} from '@telegram/context.js'
import type {Composer} from 'grammy'
import {broadcastCommand} from './telegram/handlers/broadcast-command.js'

export const broadcastCommands = [botCommand.broadcast] as const

export function register(composer: Composer<BotContext>): void {
  const privateChat = composer.chatType('private')
  privateChat.command(broadcastCommands[0], broadcastCommand)
}
