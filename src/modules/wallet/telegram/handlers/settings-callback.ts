import {editMessageWithSettings} from '@modules/wallet/telegram/messages/settings.js'
import type {BotContext} from '@telegram/context.js'

export const settingsCallback = (ctx: BotContext) => editMessageWithSettings(ctx)
