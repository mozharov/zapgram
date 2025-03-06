import {InlineKeyboard} from 'grammy'
import {config} from '../../../config.js'
import {getPaginatedAccessibleChats, getAccessibleChatsCount} from '../../../models/chat.js'
import type {BotContext} from '../../context.js'
import {buildChatsKeyboard} from '../../helpers/keyboards/chats.js'

export const chatsCommand = async (ctx: BotContext) => {
  const limit = config.chatsPerPage
  const totalChats = await getAccessibleChatsCount(ctx.user.id)
  if (totalChats === 0) {
    const keyboard = new InlineKeyboard().add({
      url: `https://t.me/${ctx.me.username}?startgroup=true`,
      text: ctx.t('button.add-chat'),
    })
    return ctx.reply(ctx.t('chats.empty'), {reply_markup: keyboard})
  }
  const chats = await getPaginatedAccessibleChats(ctx.user.id, 1, limit)
  return ctx.reply(ctx.t('chats'), {
    reply_markup: buildChatsKeyboard(ctx.t, chats, 1, totalChats > limit),
  })
}
