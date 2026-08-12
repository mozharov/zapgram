import {editMessageWithSendMenu} from '@modules/wallet/telegram/messages/send-menu.js'
import type {BotContext} from '@telegram/context.js'

export const sendMenuCallback = (ctx: BotContext) => editMessageWithSendMenu(ctx)
