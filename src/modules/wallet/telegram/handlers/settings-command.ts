import {replyWithSettings} from '@modules/wallet/telegram/messages/settings.js'
import type {BotContext} from '@telegram/context.js'

export const settingsCommand = (ctx: BotContext) => replyWithSettings(ctx)
