import {getAccessibleChatsCount, getPaginatedAccessibleChats} from '@modules/chats/repository.js'
import {buildChatsKeyboard} from '@modules/chats/telegram/keyboards/chats.js'
import type {BotContext} from '@telegram/context.js'
import {InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const chatsCommand = async (ctx: BotContext) => {
  const limit = getRuntime().config.chatsPerPage
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
