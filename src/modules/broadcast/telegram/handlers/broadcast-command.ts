import {broadcasting} from '@modules/broadcast/telegram/conversations/broadcasting.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export async function broadcastCommand(ctx: BotContext) {
  const adminIds = getRuntime().config.ADMIN_TELEGRAM_IDS
  if (!ctx.from || !adminIds.includes(ctx.from.id)) {
    // Silent ignore — command must not leak to non-admins.
    return
  }
  await ctx.conversation.enter(broadcasting.name)
}
